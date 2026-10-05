/**
 * The transport every method goes through: one `fetch`, retries, idempotency,
 * timeouts and abort.
 *
 * Three rules worth knowing about (docs/plan/agents.html §M):
 *
 *  · RETRY — 429, 5xx and "never got an answer" are retried with exponential
 *    backoff and full jitter, honouring Retry-After when the server sends one.
 *    Nothing else is: a 400 or a 403 will say the same thing next time.
 *  · IDEMPOTENCY — every write gets an `Idempotency-Key` generated once per
 *    LOGICAL call and reused across that call's retries, so a retried create
 *    is still one ticket. Pass your own to make a retry across process
 *    restarts safe too.
 *  · ABORT — the caller's signal and the per-request timeout are combined, so
 *    a timeout aborts the in-flight fetch rather than leaking it, and a
 *    caller's abort wins immediately, mid-backoff included.
 */
import { errorFromResponse, retryAfterMs, TmError, type TmErrorCode } from './errors.js';

/** The hosted build the docs point at; override with `baseUrl` for the emulators. */
export const DEFAULT_BASE_URL = 'https://taskmanager-example.web.app';

/** The `fetch` the SDK needs — the global one of Node 20+, Deno, Bun and browsers. */
export type FetchLike = typeof fetch;

export interface RetryOptions {
  /** Extra attempts after the first (default 3). 0 turns retrying off. */
  retries?: number;
  /** First backoff, doubling each time (default 250 ms). */
  baseMs?: number;
  /** Ceiling for one backoff (default 10 s). */
  maxMs?: number;
  /** Spread waits over [0, backoff] so a fleet of orchestrators doesn't sync up (default true). */
  jitter?: boolean;
  /** Last word on whether to try again. Default: `err.retryable`. */
  shouldRetry?: (err: TmError, attempt: number) => boolean;
}

export interface RequestOptions {
  /** Abort this call (and its backoff). */
  signal?: AbortSignal | undefined;
  /** Give up after this long, per attempt (default 30 s; 0 = no timeout). */
  timeoutMs?: number | undefined;
  /** Reuse a key to make a retry across process restarts safe. */
  idempotencyKey?: string | undefined;
  /** Retry settings for this call only. */
  retry?: RetryOptions | false | undefined;
  /** Extra headers for this call. */
  headers?: Record<string, string> | undefined;
}

export interface HttpOptions {
  token: string;
  /**
   * §R2 — pin every call to one board, by key ('ENG'). This is what
   * `tm.board('ENG')` sets, and what an ACCOUNT token needs on calls that do
   * not already name a ticket key. It is sent as the `board` query parameter,
   * which routes that do not need a board simply ignore. A BOARD token may
   * set it to its own board; any other key answers 404, exactly as the API
   * does. Leave it out and the token decides (phase-2 behaviour).
   *
   * §AA1 — an AGENT token is one per agent and reaches every board the agent
   * is on, so it is in the account token's position: on several boards, a
   * call that names no board is a 400 listing the keys. Set this (or use
   * `tm.board('ENG')`). Only a token converted from an old board token has a
   * default board (`me.default_board`) that such a call falls back to.
   */
  board?: string | undefined;
  /** The app's origin, or the /v1 root — both work. Default: the hosted build. */
  baseUrl?: string | undefined;
  fetch?: FetchLike | undefined;
  /** `false` or `0` turns retrying off. */
  retry?: RetryOptions | false | number | undefined;
  /** Default per-attempt timeout (default 30 s; 0 = none). */
  timeoutMs?: number | undefined;
  /** Aborts every request this client makes — the orchestrator's shutdown signal. */
  signal?: AbortSignal | undefined;
  /** Added to User-Agent, so a board's logs say which orchestrator called. */
  userAgent?: string | undefined;
  /** Swap the clock (tests). */
  now?: (() => number) | undefined;
  /** Swap the sleep (tests) — must reject with the signal's reason on abort. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Swap idempotency key generation (tests). */
  newIdempotencyKey?: (() => string) | undefined;
}

export type QueryValue = string | number | boolean | null | undefined;
/** A query parameter: one value, or a list sent as a REPEATED key (`where=…&where=…`, §AA4). */
export type QueryParam = QueryValue | readonly QueryValue[];

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY: Required<Omit<RetryOptions, 'shouldRetry'>> = {
  retries: 3,
  baseMs: 250,
  maxMs: 10_000,
  jitter: true,
};

/** `https://host` or `https://host/v1` (with or without a slash) → `https://host/v1`. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) throw new TypeError('baseUrl must not be empty');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** A random id for Idempotency-Key. randomUUID where there is one, else 24 hex chars. */
export function randomId(): string {
  const c = (
    globalThis as {
      crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(12));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 14)}`;
}

/** `?a=1&b=x`, dropping undefined and null. A list repeats its key: `?w=1&w=2`. */
export function queryString(q: Record<string, QueryParam> | undefined): string {
  if (!q) return '';
  const parts: string[] = [];
  for (const [k, value] of Object.entries(q)) {
    for (const v of Array.isArray(value)
      ? (value as readonly QueryValue[])
      : [value as QueryValue]) {
      if (v === undefined || v === null) continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

const abortReason = (signal: AbortSignal | undefined): unknown => signal?.reason;

/** An AbortError from any runtime (DOMException, Node's, or a plain object). */
function isAbort(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const name = (e as { name?: unknown }).name;
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    (e as { code?: unknown }).code === 'ABORT_ERR'
  );
}

function sleepDefault(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal) ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortReason(signal) ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One signal that fires when any of its inputs does. AbortSignal.any exists
 * in Node 20+, Deno and modern browsers; the fallback keeps Bun 1.0 and older
 * browsers working.
 */
function anySignal(signals: AbortSignal[]): { signal: AbortSignal; release: () => void } {
  const live = signals.filter(Boolean);
  if (live.length === 1) return { signal: live[0]!, release: () => void 0 };
  const AnyOf = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (AnyOf) return { signal: AnyOf(live), release: () => void 0 };
  const ctrl = new AbortController();
  const onAbort = (s: AbortSignal) => () => ctrl.abort(s.reason);
  const handlers = live.map((s) => {
    const h = onAbort(s);
    if (s.aborted) h();
    else s.addEventListener('abort', h, { once: true });
    return [s, h] as const;
  });
  return {
    signal: ctrl.signal,
    release: () => handlers.forEach(([s, h]) => s.removeEventListener('abort', h)),
  };
}

/** Exponential backoff with full jitter, but never shorter than Retry-After. */
export function backoffMs(
  attempt: number,
  cfg: Required<Omit<RetryOptions, 'shouldRetry'>>,
  serverAsked: number | null,
  rnd = Math.random,
): number {
  const exp = Math.min(cfg.maxMs, cfg.baseMs * 2 ** attempt);
  const wait = cfg.jitter ? rnd() * exp : exp;
  return Math.max(serverAsked ?? 0, wait);
}

export interface RawRequest {
  method: string;
  /** Relative to the /v1 root, e.g. `/tickets/ENG-42`. */
  path: string;
  query?: Record<string, QueryParam> | undefined;
  /** JSON-encoded unless `rawBody` is given. */
  body?: unknown;
  /**
   * A pre-built body sent as-is; give the content-type in `headers`. Bytes go
   * as a Blob and a multipart body as FormData (leave the content-type out
   * for that one: fetch writes it, with the boundary) — both can be read
   * again, so a retried upload sends the same body.
   */
  rawBody?: string | Blob | FormData | undefined;
  options?: RequestOptions | undefined;
  /** Force / suppress the Idempotency-Key (default: on for writes). */
  idempotent?: boolean | undefined;
  /** Header overrides for this call (Accept, Content-Type …). */
  headers?: Record<string, string> | undefined;
}

/**
 * The client's HTTP layer. `json()` is what the typed methods call; `raw()`
 * hands back the Response for the one caller that streams it (SSE).
 */
export class Http {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly doFetch: FetchLike;
  private readonly retry: Required<Omit<RetryOptions, 'shouldRetry'>> &
    Pick<RetryOptions, 'shouldRetry'>;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly userAgent: string | undefined;
  /** §R2: the board every call is pinned to (`tm.board('ENG')`), or undefined. */
  readonly board: string | undefined;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly newKey: () => string;

  constructor(opts: HttpOptions) {
    if (!opts.token || typeof opts.token !== 'string')
      throw new TypeError('createClient({ token }) is required');
    this.token = opts.token;
    this.baseUrl = normalizeBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL);
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    if (!opts.fetch && !globalFetch)
      throw new TypeError('No global fetch in this runtime — pass createClient({ fetch })');
    // Called through globalThis: an unbound `fetch` throws "Illegal invocation" in browsers.
    this.doFetch =
      opts.fetch ??
      (((input, init) => (globalThis as { fetch: FetchLike }).fetch(input, init)) as FetchLike);
    const r =
      opts.retry === false
        ? { retries: 0 }
        : typeof opts.retry === 'number'
          ? { retries: opts.retry }
          : (opts.retry ?? {});
    this.retry = { ...DEFAULT_RETRY, ...r };
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.signal = opts.signal;
    this.userAgent = opts.userAgent;
    this.board = opts.board || undefined;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? sleepDefault;
    this.newKey = opts.newIdempotencyKey ?? randomId;
  }

  /** The Authorization header and friends, for a caller building its own request. */
  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
      ...(this.userAgent ? { 'user-agent': this.userAgent } : {}),
      ...extra,
    };
  }

  /**
   * Absolute URL for a /v1-relative path.
   *
   * §R2: a client pinned to a board adds `board=<key>` to every call, unless
   * the caller named one for this call. Routes that do not take a board
   * ignore the parameter (their query schemas drop unknown keys), so one rule
   * covers the whole API instead of a list of routes to keep in step.
   */
  url(path: string, query?: Record<string, QueryParam>): string {
    const q =
      this.board !== undefined && (query?.board === undefined || query.board === null)
        ? { ...query, board: this.board }
        : query;
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}${queryString(q)}`;
  }

  /**
   * One attempt, no retry, no body reading — the escape hatch SSE uses. The
   * returned Response's body is still open.
   */
  async raw(req: RawRequest): Promise<Response> {
    const { promise, release } = this.attempt(req);
    try {
      return await promise;
    } finally {
      release();
    }
  }

  /** A request with retries; parses JSON, throws TmError on any non-2xx. */
  async json<T>(req: RawRequest): Promise<T> {
    const res = await this.send(req);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TmError({
        code: 'internal',
        status: res.status,
        message: `${req.method} ${req.path} — the answer was not JSON`,
        method: req.method,
        url: req.path,
      });
    }
  }

  /** A request with retries, returning the Response with its body unread. */
  async send(req: RawRequest): Promise<Response> {
    const perCall = req.options?.retry;
    const cfg =
      perCall === false ? { ...this.retry, retries: 0 } : { ...this.retry, ...(perCall ?? {}) };
    // Generated ONCE and reused below: a retried write must be the same write.
    const idemKey =
      req.options?.idempotencyKey ??
      ((req.idempotent ?? WRITE_METHODS.has(req.method.toUpperCase())) ? this.newKey() : undefined);
    const withKey: RawRequest = {
      ...req,
      options: { ...req.options, ...(idemKey ? { idempotencyKey: idemKey } : {}) },
    };

    let attempt = 0;
    for (;;) {
      const { promise, release } = this.attempt(withKey);
      let res: Response;
      try {
        res = await promise;
      } catch (e) {
        release();
        const err = e as TmError;
        if (attempt >= cfg.retries || !(cfg.shouldRetry?.(err, attempt) ?? err.retryable))
          throw err;
        await this.waitBeforeRetry(attempt, err.retryAfterMs, req.options?.signal);
        attempt++;
        continue;
      }
      release();
      if (res.ok) return res;
      const err = await this.errorFor(withKey, res);
      if (attempt >= cfg.retries || !(cfg.shouldRetry?.(err, attempt) ?? err.retryable)) throw err;
      await this.waitBeforeRetry(attempt, err.retryAfterMs, req.options?.signal);
      attempt++;
    }
  }

  private async waitBeforeRetry(
    attempt: number,
    serverAsked: number | null,
    callerSignal: AbortSignal | undefined,
  ): Promise<void> {
    const { signal, release } = anySignal(
      [callerSignal, this.signal].filter(Boolean) as AbortSignal[],
    );
    try {
      await this.sleep(backoffMs(attempt, this.retry, serverAsked), signal);
    } catch (e) {
      throw new TmError({
        code: 'aborted',
        status: 0,
        message: 'The request was aborted',
        cause: e,
      });
    } finally {
      release();
    }
  }

  /** Read the failed answer's body and turn it into a TmError. */
  private async errorFor(req: RawRequest, res: Response): Promise<TmError> {
    let body: unknown = null;
    try {
      const text = await res.text();
      body = text
        ? ((): unknown => {
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          })()
        : null;
    } catch {
      /* a body we cannot read is no worse than no body */
    }
    return errorFromResponse(res.status, body, {
      method: req.method,
      url: req.path,
      retryAfterMs: retryAfterMs(res.headers.get('retry-after'), this.now()) ?? undefined,
    });
  }

  /** One fetch, with the timeout and the caller's signal wired up. */
  private attempt(req: RawRequest): { promise: Promise<Response>; release: () => void } {
    const timeoutMs = req.options?.timeoutMs ?? this.timeoutMs;
    const timer = new AbortController();
    const signals = [req.options?.signal, this.signal, timer.signal].filter(
      Boolean,
    ) as AbortSignal[];
    const { signal, release: releaseAny } = anySignal(signals);
    let timedOut = false;
    const handle =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            timer.abort(new Error(`Timed out after ${timeoutMs} ms`));
          }, timeoutMs)
        : undefined;
    const release = (): void => {
      if (handle !== undefined) clearTimeout(handle);
      releaseAny();
    };

    const headers = this.headers({
      ...(req.body !== undefined && req.rawBody === undefined
        ? { 'content-type': 'application/json' }
        : {}),
      ...(req.options?.idempotencyKey ? { 'idempotency-key': req.options.idempotencyKey } : {}),
      ...(req.headers ?? {}),
      ...(req.options?.headers ?? {}),
    });

    const init: RequestInit = {
      method: req.method,
      headers,
      signal,
      ...(req.rawBody !== undefined
        ? { body: req.rawBody }
        : req.body !== undefined
          ? { body: JSON.stringify(req.body) }
          : {}),
    };

    const promise = (async (): Promise<Response> => {
      try {
        return await this.doFetch(this.url(req.path, req.query), init);
      } catch (e) {
        throw this.transportError(req, e, timedOut);
      }
    })();
    return { promise, release };
  }

  private transportError(req: RawRequest, e: unknown, timedOut: boolean): TmError {
    if (timedOut)
      return new TmError({
        code: 'timeout',
        status: 0,
        message: `${req.method} ${req.path} — timed out`,
        method: req.method,
        url: req.path,
        cause: e,
      });
    const aborted =
      isAbort(e) || req.options?.signal?.aborted === true || this.signal?.aborted === true;
    const code: TmErrorCode = aborted ? 'aborted' : 'network';
    return new TmError({
      code,
      status: 0,
      message: `${req.method} ${req.path} — ${aborted ? 'aborted' : `could not reach the server (${(e as Error)?.message ?? e})`}`,
      method: req.method,
      url: req.path,
      cause: e,
    });
  }
}

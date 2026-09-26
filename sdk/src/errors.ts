/**
 * One error type for everything the SDK does.
 *
 * The API answers failures with RFC 9457 problem+json (shared/errors.ts), so
 * a TmError carries the whole problem body plus the two things a caller
 * actually branches on: `code` ('forbidden', 'rate_limited', …) and `status`.
 * Network failures and timeouts get codes of their own ('network',
 * 'timeout', 'aborted') with status 0, so `catch (e) { if (e.code === …) }`
 * works the same whether the server said no or was never reached.
 */
import type { Scope } from './types.js';

/** The codes the server sends, plus the three only a client can see. */
export type TmErrorCode =
  | 'invalid'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'gone'
  | 'too_large'
  | 'unprocessable'
  | 'rate_limited'
  | 'internal'
  | 'unavailable'
  /** The request never got an answer (DNS, connection reset, offline). */
  | 'network'
  /** The request timed out (`timeoutMs`). */
  | 'timeout'
  /** The caller's AbortSignal fired. */
  | 'aborted';

/** RFC 9457 problem details, plus our `code` and any extension members. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  [key: string]: unknown;
}

const STATUS_CODE: Record<number, TmErrorCode> = {
  400: 'invalid',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  413: 'too_large',
  422: 'unprocessable',
  429: 'rate_limited',
  500: 'internal',
  503: 'unavailable',
};

const CODES = new Set<string>([
  'invalid',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'gone',
  'too_large',
  'unprocessable',
  'rate_limited',
  'internal',
  'unavailable',
  'network',
  'timeout',
  'aborted',
]);

/** Map an HTTP status to a code, for answers without a problem body. */
export function codeForStatus(status: number): TmErrorCode {
  return STATUS_CODE[status] ?? (status >= 500 ? 'internal' : 'invalid');
}

export interface TmErrorInit {
  code: TmErrorCode;
  status: number;
  message: string;
  /** The problem+json body, when the server sent one. */
  problem?: Problem | undefined;
  method?: string | undefined;
  /** Path only — never the token. */
  url?: string | undefined;
  /** Seconds from a 429's Retry-After header. */
  retryAfterMs?: number | undefined;
  cause?: unknown;
}

export class TmError extends Error {
  override readonly name = 'TmError';
  readonly code: TmErrorCode;
  /** The HTTP status, or 0 when the request never got an answer. */
  readonly status: number;
  /** The problem+json body the server sent, verbatim; null otherwise. */
  readonly problem: Problem | null;
  readonly method: string | null;
  readonly url: string | null;
  /** How long the server asked us to wait (429 / 503 Retry-After), in ms. */
  readonly retryAfterMs: number | null;

  constructor(init: TmErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = init.code;
    this.status = init.status;
    this.problem = init.problem ?? null;
    this.method = init.method ?? null;
    this.url = init.url ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
  }

  /** zod issues on a 400, `missing` on a 422, `current` on a stale 409 … */
  get details(): Record<string, unknown> {
    if (!this.problem) return {};
    const { type: _t, title: _ti, status: _s, detail: _d, instance: _i, code: _c, ...rest } = this.problem;
    return rest;
  }

  /** The scopes a 403 says the token is missing, when it named any. */
  get missingScopes(): Scope[] {
    const m = this.details['scopes'] ?? this.details['missing'];
    return Array.isArray(m) ? (m.filter((s) => typeof s === 'string') as Scope[]) : [];
  }

  /** Worth sending again as-is? (the client retries these automatically) */
  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'network' || this.code === 'timeout' || this.status >= 500;
  }
}

/**
 * True for a TmError from any copy of the SDK — `instanceof` alone breaks
 * when two bundles end up in one process (a URL import beside a tarball).
 */
export function isTmError(e: unknown): e is TmError {
  return (
    e instanceof TmError ||
    (typeof e === 'object' &&
      e !== null &&
      (e as { name?: unknown }).name === 'TmError' &&
      typeof (e as { code?: unknown }).code === 'string' &&
      CODES.has((e as { code: string }).code))
  );
}

/** `Retry-After: 3` (seconds) or an HTTP date → ms, or null. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const secs = Number(header.trim());
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Build the error for a non-2xx answer, using the problem body when there is one. */
export function errorFromResponse(
  status: number,
  body: unknown,
  ctx: { method: string; url: string; retryAfterMs?: number | undefined },
): TmError {
  const problem =
    typeof body === 'object' && body !== null && typeof (body as Problem).code === 'string'
      ? (body as Problem)
      : undefined;
  const code = problem && CODES.has(problem.code) ? (problem.code as TmErrorCode) : codeForStatus(status);
  const message =
    problem?.detail ??
    problem?.title ??
    (typeof body === 'string' && body.trim() ? body.slice(0, 300) : `HTTP ${status}`);
  return new TmError({
    code,
    status,
    message: `${ctx.method} ${ctx.url} — ${message}`,
    problem,
    method: ctx.method,
    url: ctx.url,
    retryAfterMs: ctx.retryAfterMs,
  });
}

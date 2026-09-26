/**
 * tm.watch() — AGENTS WAKE, THEY DO NOT POLL (docs/plan/agents.html §W).
 *
 * The measurement that produced this file: two orchestrator loops, each
 * running every ~30 s, were 88 % of every request this API served — 8,822
 * `GET /v1/tickets` and 8,815 `GET /v1/events` in three days, each one a FULL
 * scan (`limit=200`, no `updated_since`; `unacked=1`, no cursor) whether or
 * not anything had changed. Cloud Run bills CPU for the WHOLE request, so an
 * idle agent was the single largest line on the bill.
 *
 * The shape that costs nothing instead:
 *
 *   ONE streaming connection to the Realtime Database, held open by Google's
 *   edge and NOT by a Cloud Run request, to the two tiny nodes the command
 *   layer bumps (shared/src/rtdb.ts):
 *
 *       rev/{boardId}            'something on this board changed'
 *       agents/{agentId}/wake    'something is in your inbox'
 *
 *   The RTDB's REST API streams those as plain Server-Sent Events, so there
 *   is no Firebase SDK here and this works unchanged in Deno, Bun and Node.
 *   Bandwidth, not operations: an idle watcher is a socket and ~0 bytes.
 *
 *   Then, and ONLY then, one REST call that asks for the DELTA —
 *   `updated_since` for tickets, `cursor` for events — so the answer is what
 *   changed, not the world.
 *
 * WHEN A STREAM CANNOT BE OPENED (no live credential from the API, a proxy
 * that eats SSE, a runtime without streaming bodies) this degrades to
 * polling, which is what every orchestrator does today — but on a BACKOFF:
 * seconds while work is arriving, a minute when idle (§W: "polling stays
 * supported, but the SDK's own loop backs off to a minute when idle"). Tell
 * it which it was with `watcher.found(n)` after each delta fetch.
 *
 *   const w = tm.watch();
 *   for await (const signal of w) {
 *     const page = await tm.events.list({ cursor, unacked: true });
 *     cursor = page.next_cursor ?? cursor;
 *     for (const ev of page.data) handle(ev);
 *     w.found(page.data.length);        // 0 ⇒ back off, >0 ⇒ stay eager
 *   }
 *
 * `tm.work()` is this loop, written for you.
 */
import { TmError } from './errors.js';
import { readSse } from './sse.js';
import type { Me } from './types.js';

// ───────────────────────── what comes out ─────────────────────────

/** How the wake arrived. `'stream'` is the free one. */
export type WatchSource = 'stream' | 'poll';

/**
 * Why the watcher woke its caller.
 *   'open'   the watcher just started — do your first delta fetch
 *   'inbox'  agents/{id}/wake moved: something is in this agent's inbox
 *   'board'  rev/{boardId} moved: something on that board changed
 *   'poll'   the backstop timer fired; nothing is known to have changed
 */
export type WatchReason = 'open' | 'inbox' | 'board' | 'poll';

export interface WatchSignal {
  reason: WatchReason;
  /** The board it is about, when the signal names one. */
  board: string | null;
  /** Client clock, millis. */
  at: number;
  source: WatchSource;
}

// ───────────────────────── what goes in ─────────────────────────

/**
 * What the API hands back for opening a live connection: an RTDB origin and a
 * short-lived credential scoped exactly as `backend/database.rules.json`
 * expects — uid = the agent id, custom claim `board` = the one board it was
 * issued for. `GET /v1/live` mints it (phase 17), and `watch()` asks for it
 * once, re-minting as it expires. Where the route answers anything but a
 * credential (an old server, a proxy that eats SSE) `watch()` polls on the
 * backoff schedule instead. Pass `createClient({ live })` to supply one by
 * hand, or `live: false` to skip the lookup entirely.
 */
export interface LiveCredential {
  /** `https://<instance>.<region>.firebasedatabase.app` */
  database_url: string;
  /** The `?auth=` token. Omitted when the database is open (the emulator). */
  auth?: string | null | undefined;
  /** Seconds. Advisory: the stream reconnects and re-mints when it expires. */
  expires_in?: number | null | undefined;
  /**
   * The exact RTDB paths this credential may stream. When the server names
   * them, they win; otherwise they are derived from `GET /v1/me`.
   */
  paths?: readonly string[] | undefined;
}

/** What to listen to. `'auto'`: the inbox for an agent, the board otherwise. */
export type WatchTarget = 'auto' | 'inbox' | 'board' | 'all';

export interface WatchOptions {
  /** Default `'auto'`. */
  target?: WatchTarget | undefined;
  /** Stream these RTDB paths instead of the derived ones. */
  paths?: readonly string[] | undefined;
  /** Stop the watcher. */
  signal?: AbortSignal | undefined;
  /** Polling floor, while work is arriving (default 2 s). */
  minPollMs?: number | undefined;
  /** Polling ceiling, when idle (default 60 s — §W). */
  maxPollMs?: number | undefined;
  /**
   * How often to fetch anyway WHILE STREAMING, in case a bump was lost
   * (default 15 min; 0 turns the backstop off). This is the only REST traffic
   * an idle streaming watcher makes.
   */
  backstopMs?: number | undefined;
  /** Never open a stream; poll on the backoff schedule. */
  poll?: boolean | undefined;
  /** Supply the credential instead of asking the API; `false` = never stream. */
  live?: LiveCredential | false | undefined;
  /** Called when the stream cannot be used, with the reason. Default: silent. */
  onDegrade?: ((reason: string) => void) | undefined;
}

/**
 * A running watcher. Iterate it for wake signals; tell it what each wake was
 * worth with `found()` so the polling fallback knows whether to stay eager.
 */
export interface Watcher extends AsyncIterable<WatchSignal> {
  /** How wakes are arriving right now. */
  readonly source: WatchSource;
  /** Why it is polling, when it is — `null` while streaming. */
  readonly degraded: string | null;
  /** The RTDB paths it is streaming (empty while polling). */
  readonly paths: readonly string[];
  /** After a delta fetch: how many rows it returned. 0 backs the poll off. */
  found(count: number): void;
  /** Stop, and end the iteration. */
  stop(): void;
}

/** The slice of the client `watch()` needs — keeps the client's type flat. */
export interface WatchDeps {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** A fetch with NO TaskManager auth on it: the RTDB takes `?auth=` instead. */
  fetch: typeof fetch;
  /** `GET /v1/live`. Rejects with `not_found` where the route does not exist. */
  live: (o: { signal?: AbortSignal | undefined }) => Promise<LiveCredential>;
  /** `GET /v1/me`, for deriving the paths and the agent id. */
  me: (o: { signal?: AbortSignal | undefined }) => Promise<Me>;
}

export const DEFAULT_MIN_POLL_MS = 2_000;
export const DEFAULT_MAX_POLL_MS = 60_000;
export const DEFAULT_BACKSTOP_MS = 15 * 60_000;
/** Reconnect backoff for a stream that drops, in ms. */
const STREAM_RETRY_MIN_MS = 500;
const STREAM_RETRY_MAX_MS = 30_000;

// ───────────────────────── the RTDB wire ─────────────────────────

/**
 * The paths of §W, spelled here rather than imported: the SDK has ZERO
 * runtime dependencies, so it cannot import `live` from @tm/shared. They are
 * the same strings — shared/src/rtdb.ts is the source of truth.
 */
export const livePaths = {
  rev: (boardId: string): string => `rev/${boardId}`,
  wake: (agentId: string): string => `agents/${agentId}/wake`,
} as const;

/**
 * Which nodes this token should listen to, from what `/v1/me` says it is.
 * An agent's inbox is `agents/{id}/wake`; a board's activity is `rev/{id}`.
 */
export function pathsFor(me: Me, target: WatchTarget): string[] {
  const boards = me.board ? [me.board] : (me.boards ?? []);
  const isAgent = me.principal.kind === 'agent';
  const want = target === 'auto' ? (isAgent ? 'inbox' : 'board') : target;
  const out: string[] = [];
  if ((want === 'inbox' || want === 'all') && isAgent) out.push(livePaths.wake(me.principal.id));
  if (want === 'board' || want === 'all') for (const b of boards) out.push(livePaths.rev(b.id));
  // An account token asking for its inbox has no wake node of its own: the
  // boards it reaches are the next best thing, and cost the same.
  if (!out.length) for (const b of boards) out.push(livePaths.rev(b.id));
  return out;
}

/**
 * The `at` a `put` / `patch` frame carries, or null when it holds none.
 *
 * WHY THIS AND NOT "a frame arrived". The RTDB replays the CURRENT value as a
 * `put` on every (re)connect. Waking on that would turn a flapping connection
 * into a polling loop with extra steps — so a frame only counts when the
 * node's own timestamp has actually moved past the last one seen.
 */
export function revisionOf(data: unknown): number | null {
  if (typeof data === 'number') return Number.isFinite(data) ? data : null;
  if (!data || typeof data !== 'object') return null;
  const at = (data as { at?: unknown }).at;
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  // A `put` at a parent node hands back its children; take the newest.
  let best: number | null = null;
  for (const child of Object.values(data as Record<string, unknown>)) {
    const n = revisionOf(child);
    if (n !== null && (best === null || n > best)) best = n;
  }
  return best;
}

/** `{"path":"/","data":…}` — what an RTDB `put` / `patch` frame's data is. */
function parseRtdbFrame(raw: string): { path: string; data: unknown } | null {
  try {
    const v = JSON.parse(raw) as { path?: unknown; data?: unknown };
    if (!v || typeof v !== 'object') return null;
    return { path: typeof v.path === 'string' ? v.path : '/', data: v.data };
  } catch {
    return null;
  }
}

/** `rev/b1` → the board id it is about, or null for a wake path. */
function boardOfPath(path: string): string | null {
  const m = /^rev\/([^/]+)$/.exec(path);
  return m ? m[1]! : null;
}

// ───────────────────────── a one-slot signal queue ─────────────────────────

/**
 * At most ONE wake is ever queued. A burst of ten bumps while the consumer is
 * busy is still one delta fetch — that is the whole economy of this file — so
 * a new signal replaces a waiting one rather than stacking behind it. A real
 * change ('inbox' / 'board') outranks a 'poll' when they collide.
 */
class SignalBox {
  private queued: WatchSignal | null = null;
  private waiter: ((r: IteratorResult<WatchSignal>) => void) | null = null;
  private closed = false;

  push(s: WatchSignal): void {
    if (this.closed) return;
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      w({ value: s, done: false });
      return;
    }
    const held = this.queued;
    this.queued = held && held.reason !== 'poll' && s.reason === 'poll' ? held : s;
  }

  close(): void {
    this.closed = true;
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      w({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<WatchSignal>> {
    const held = this.queued;
    if (held) {
      this.queued = null;
      return Promise.resolve({ value: held, done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

// ───────────────────────── the watcher ─────────────────────────

/**
 * Build a watcher. Nothing happens until it is iterated — the credential
 * lookup, the streams and the timer all start on the first `next()`, so an
 * unused `tm.watch()` costs nothing at all.
 */
export function createWatcher(deps: WatchDeps, opts: WatchOptions = {}): Watcher {
  const minPoll = Math.max(50, opts.minPollMs ?? DEFAULT_MIN_POLL_MS);
  const maxPoll = Math.max(minPoll, opts.maxPollMs ?? DEFAULT_MAX_POLL_MS);
  const backstop = opts.backstopMs ?? DEFAULT_BACKSTOP_MS;
  const onDegrade = opts.onDegrade ?? ((): void => void 0);

  const box = new SignalBox();
  const stopper = new AbortController();
  const stop = (): void => {
    if (!stopper.signal.aborted) stopper.abort(new Error('watch stopped'));
    box.close();
  };
  if (opts.signal?.aborted) stop();
  else opts.signal?.addEventListener('abort', stop, { once: true });

  const state = {
    source: 'poll' as WatchSource,
    degraded: 'starting' as string | null,
    paths: [] as string[],
    /** Current poll wait, doubling while nothing is found. */
    wait: minPoll,
    /** When the caller was last woken — what the next poll is measured from. */
    lastWakeAt: deps.now(),
    started: false,
  };

  const wake = (reason: WatchReason, board: string | null): void => {
    state.lastWakeAt = deps.now();
    box.push({ reason, board, at: state.lastWakeAt, source: state.source });
  };

  // ── the credential ────────────────────────────────────────────────────────

  async function credential(): Promise<LiveCredential | null> {
    if (opts.poll === true || opts.live === false) return null;
    if (opts.live) return opts.live;
    try {
      return await deps.live({ signal: stopper.signal });
    } catch (e) {
      // A server without the mint route answers 404; anything else gets the
      // same treatment — polling still works, and says why.
      const code = e instanceof TmError ? e.code : 'network';
      onDegrade(`no live credential (${code})`);
      state.degraded = `no live credential (${code})`;
      return null;
    }
  }

  // ── one stream, held open, reconnecting on its own ────────────────────────

  async function streamOne(cred: LiveCredential, path: string): Promise<void> {
    const origin = cred.database_url.replace(/\/+$/, '');
    const board = boardOfPath(path);
    let seen = -1;
    let retry = STREAM_RETRY_MIN_MS;
    while (!stopper.signal.aborted) {
      try {
        const url = `${origin}/${path}.json${cred.auth ? `?auth=${encodeURIComponent(cred.auth)}` : ''}`;
        // No timeout: a stream is meant to stay open, and the RTDB's edge —
        // not a Cloud Run request — is what holds it.
        const res = await deps.fetch(url, {
          method: 'GET',
          headers: { accept: 'text/event-stream' },
          signal: stopper.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        state.source = 'stream';
        state.degraded = null;
        retry = STREAM_RETRY_MIN_MS;
        for await (const frame of readSse(res.body, stopper.signal)) {
          if (frame.event === 'keep-alive' || frame.event === 'ping') continue;
          if (frame.event === 'auth_revoked' || frame.event === 'cancel') {
            throw new Error(frame.event);
          }
          if (frame.event !== 'put' && frame.event !== 'patch') continue;
          const body = parseRtdbFrame(frame.data);
          if (!body) continue;
          const at = revisionOf(body.data);
          // No timestamp to compare (a patch of one field, a delete): trust it.
          if (at === null) {
            if (body.data !== null) wake(board ? 'board' : 'inbox', board);
            continue;
          }
          if (at <= seen) continue; // the reconnect replay, or an older child
          const first = seen < 0;
          seen = at;
          // The value that was already there when we connected is not news:
          // the 'open' signal has already told the caller to do a first fetch.
          if (!first) wake(board ? 'board' : 'inbox', board);
        }
        // A clean end (the RTDB rotates connections) — reconnect at once.
      } catch (e) {
        if (stopper.signal.aborted) return;
        state.source = 'poll';
        state.degraded = `stream down (${e instanceof Error ? e.message : String(e)})`;
        onDegrade(state.degraded);
        try {
          await deps.sleep(retry, stopper.signal);
        } catch {
          return;
        }
        retry = Math.min(STREAM_RETRY_MAX_MS, retry * 2);
      }
    }
  }

  // ── the timer: a backstop while streaming, the whole loop while polling ───

  /**
   * The next poll is due `interval()` after the LAST wake of any kind — so a
   * stream that is delivering keeps pushing the backstop out, and a caller
   * that just did a delta fetch does not get polled a second later.
   *
   * `found()` changes the interval, so it also interrupts the wait: the point
   * of "seconds while work is arriving" is lost if the first eager poll only
   * lands after the minute that was already ticking.
   */
  let tick: AbortController | null = null;
  const reschedule = (): void => {
    const t = tick;
    tick = null;
    t?.abort(new Error('reschedule'));
  };

  const interval = (): number =>
    state.source === 'stream'
      ? backstop > 0
        ? backstop
        : Number.POSITIVE_INFINITY
      : state.wait;

  async function ticker(): Promise<void> {
    while (!stopper.signal.aborted) {
      const iv = interval();
      const wait = Number.isFinite(iv) ? state.lastWakeAt + iv - deps.now() : maxPoll;
      if (Number.isFinite(iv) && wait <= 0) {
        wake('poll', null);
        continue;
      }
      const ctrl = new AbortController();
      tick = ctrl;
      const onStop = (): void => ctrl.abort(stopper.signal.reason);
      stopper.signal.addEventListener('abort', onStop, { once: true });
      try {
        await deps.sleep(Math.max(1, wait), ctrl.signal);
      } catch {
        // Either we were stopped, or found() asked for a new schedule.
        if (stopper.signal.aborted) return;
      } finally {
        stopper.signal.removeEventListener('abort', onStop);
        if (tick === ctrl) tick = null;
      }
    }
  }

  // ── start, once, on the first pull ────────────────────────────────────────

  async function start(): Promise<void> {
    const cred = await credential();
    if (stopper.signal.aborted) return;
    if (cred) {
      let paths = [...(opts.paths ?? cred.paths ?? [])];
      if (!paths.length) {
        try {
          paths = pathsFor(await deps.me({ signal: stopper.signal }), opts.target ?? 'auto');
        } catch (e) {
          state.degraded = `cannot tell what to watch (${e instanceof Error ? e.message : String(e)})`;
          onDegrade(state.degraded);
          paths = [];
        }
      }
      state.paths = paths;
      if (paths.length) {
        // Optimistic, and on purpose: the ticker reads `source` to decide
        // between the long backstop and the polling backoff, and it must not
        // fire a poll in the window before the first connection comes up.
        // streamOne() flips it back to 'poll' the moment a stream fails.
        state.source = 'stream';
        state.degraded = null;
      } else {
        state.degraded ??= 'nothing to watch';
      }
      // Each path is its own connection; the common case — one board token
      // acting as one agent — is exactly one.
      for (const p of paths) void streamOne(cred, p);
    }
    void ticker();
  }

  const iterator: AsyncIterator<WatchSignal> = {
    next(): Promise<IteratorResult<WatchSignal>> {
      if (!state.started) {
        state.started = true;
        // The caller gets its first fetch immediately — a restarted
        // orchestrator must drain whatever piled up while it was gone.
        wake('open', null);
        void start();
      }
      return box.next();
    },
    return(): Promise<IteratorResult<WatchSignal>> {
      stop();
      return Promise.resolve({ value: undefined as never, done: true });
    },
    throw(e?: unknown): Promise<IteratorResult<WatchSignal>> {
      stop();
      return Promise.reject(e);
    },
  };

  return {
    get source(): WatchSource {
      return state.source;
    },
    get degraded(): string | null {
      return state.degraded;
    },
    get paths(): readonly string[] {
      return state.paths;
    },
    found(count: number): void {
      // Seconds while work is arriving, a minute when idle (§W).
      state.wait = count > 0 ? minPoll : Math.min(maxPoll, state.wait * 2);
      reschedule();
    },
    stop,
    [Symbol.asyncIterator]: () => iterator,
  };
}

/**
 * tm.work(handler, { concurrency, filter }) — a whole orchestrator in one
 * call (docs/plan/agents.html §M, and §W for what it costs).
 *
 * The loop it saves you writing:
 *
 *   WAIT to be woken  →  ask for the events you have not seen  →  run your
 *   handler for each  →  keep a heartbeat alive on that ticket while it runs
 *   →  mark it done (or error, with the message)  →  ack the event, but only
 *   once the handler returned.
 *
 * Acking last is the point: a crash mid-handler leaves the event unacked, so
 * the next run picks it up again. The heartbeat is what makes the ticket say
 * "🟢 Working · …" in the app for as long as the handler is running, and
 * "🔴 Stopped with an error" the moment it throws.
 *
 * Two events for the SAME ticket never run at once, whatever `concurrency`
 * says — two handlers editing one ticket's task list would race, and the
 * second event is almost always about the first one's own work.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS WAITS ON tm.watch() AND NOT ON /v1/events/stream (§W)
 *
 * /v1/events/stream is Server-Sent Events served from inside the `api`
 * function, and Cloud Run BILLS CPU FOR THE WHOLE LIFE OF A REQUEST — waiting
 * on I/O included. A stream that is held open is therefore billed for every
 * second it is held open, whether or not a single event crosses it. An
 * always-connected agent on SSE is the most expensive thing this API offers:
 * it turns an idle orchestrator into a permanently-running container.
 * (Measured, 23–26 Sep 2026: the `api` function burnt 11,963 billable
 * vCPU-seconds of 13,775 — 87 % — almost all of it waiting.)
 *
 * `tm.watch()` waits on the Realtime Database instead. That connection is
 * held by Google's edge, not by a function; the RTDB bills BANDWIDTH, not
 * time, and the node it watches is a handful of bytes the command layer
 * overwrites when something actually changes. The function is then touched
 * once, briefly, per real change — and asked for the DELTA (`cursor`,
 * `unacked`), not the world.
 *
 * The SSE stream is still there, and `work(handler, { transport: 'stream' })`
 * still uses it. Choose it knowingly: it is the expensive one.
 * ─────────────────────────────────────────────────────────────────────────
 */
import type { Beat, EventQuery, HeartbeatInput, StreamOptions, TmClient } from './client.js';
import type { EventPage, EventType, TmEvent } from './types.js';
import type { WatchOptions, Watcher } from './watch.js';

/** What a handler is given. */
export interface WorkContext {
  /** The inbox event that started this run. */
  event: TmEvent;
  /** The ticket it is about, e.g. 'ENG-42'; null for a ticketless event. */
  ticket: string | null;
  /** The client, so the handler can read and write without capturing one. */
  tm: TmClient;
  /**
   * The heartbeat kept alive for this run. `beat.update({ message })` is what
   * puts "Running tests (3/12)" on the ticket. done / error are sent for you.
   */
  beat: Beat | null;
  /** Fires when `work()` is asked to stop — pass it to your own awaits. */
  signal: AbortSignal;
}

export type WorkHandler = (ctx: WorkContext) => void | Promise<void>;

export interface WorkOptions extends Omit<StreamOptions, 'ack'> {
  /**
   * How the loop learns there is something to do (§W).
   *   'watch'  (default) wait on the RTDB, then fetch the delta — nearly free
   *   'stream' hold /v1/events/stream open — billed for every second it is
   *            open, because Cloud Run bills a held request's whole life
   */
  transport?: 'watch' | 'stream';
  /** Passed to `tm.watch()` — poll backoff, an explicit credential, `poll: true`. */
  watch?: WatchOptions;
  /** How many events may be in flight at once (default 1). */
  concurrency?: number;
  /** Which events to take: a list of types, or a predicate. Default: all of them. */
  filter?: readonly EventType[] | ((event: TmEvent) => boolean);
  /** Heartbeat settings, or `false` for none (a token without `status:write`). */
  heartbeat?: false | { everyMs?: number; message?: string };
  /** Called when a handler throws. The default logs and carries on. */
  onError?: (error: unknown, event: TmEvent) => void;
  /** Stop after this many events have been handled (tests, one-shot runs). */
  max?: number;
  /** Ack handled events (default true). */
  ack?: boolean;
}

export interface WorkSummary {
  handled: number;
  failed: number;
  /** The last cursor seen, so a caller can resume elsewhere. */
  cursor: string | null;
}

/** The slice of the client `work()` uses — keeps the client's own type flat. */
export interface WorkDeps {
  /** The expensive transport, kept for `transport: 'stream'`. */
  stream: (opts: StreamOptions) => AsyncGenerator<TmEvent>;
  /** The cheap one: wake on a change. */
  watch: (opts: WatchOptions) => Watcher;
  /** One delta page of the inbox. */
  list: (q: EventQuery) => Promise<EventPage>;
  ack: (ids: string[], o?: { signal?: AbortSignal }) => Promise<{ acked: number }>;
  startBeat: (input: HeartbeatInput & { everyMs?: number; onError?: (e: unknown) => void }) => Beat;
}

/**
 * THE CHEAP INBOX (§W): sleep on `tm.watch()`, and on each wake ask for
 * exactly what has not been seen — `cursor` forward, `unacked` only — paging
 * until the delta is drained. An idle agent makes NO request at all; a busy
 * one makes one request per burst of changes, not one per 30 seconds.
 *
 * `watcher.found()` after each drain is what keeps the POLLING fallback
 * honest: seconds while work is arriving, a minute when idle.
 */
async function* watchEvents(
  deps: WorkDeps,
  opts: WorkOptions,
  signal: AbortSignal,
): AsyncGenerator<TmEvent> {
  const watcher = deps.watch({ ...(opts.watch ?? {}), signal });
  // Events already acked are, by definition, already done — never re-run them.
  const unacked = opts.unacked ?? true;
  let cursor = opts.cursor;
  try {
    for await (const _wake of watcher) {
      let drained = 0;
      for (;;) {
        const page: EventPage = await deps.list({
          ...(cursor !== undefined ? { cursor } : {}),
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          unacked,
          signal,
        });
        for (const event of page.data) {
          drained += 1;
          cursor = event.id;
          yield event;
        }
        if (signal.aborted) break;
        // `has_more` is the server's own word for "there is another page".
        if (!page.has_more || !page.next_cursor || page.data.length === 0) break;
        cursor = page.next_cursor;
      }
      watcher.found(drained);
      if (signal.aborted) break;
    }
  } finally {
    watcher.stop();
  }
}

const matcher = (filter: WorkOptions['filter']): ((e: TmEvent) => boolean) => {
  if (!filter) return () => true;
  if (typeof filter === 'function') return filter;
  const set = new Set<string>(filter);
  return (e) => set.has(e.type);
};

/** A fixed number of slots; `acquire` waits for one to come free. */
function semaphore(n: number): { acquire: () => Promise<void>; release: () => void } {
  let free = Math.max(1, n);
  const waiting: (() => void)[] = [];
  return {
    acquire: () =>
      free > 0
        ? ((free -= 1), Promise.resolve())
        : new Promise<void>((resolve) => waiting.push(() => ((free -= 1), resolve()))),
    release: () => {
      free += 1;
      waiting.shift()?.();
    },
  };
}

/**
 * Run the orchestrator loop until the signal aborts, the stream ends, or
 * `max` events have been handled. Resolves with what it did.
 */
export async function workLoop(
  deps: WorkDeps,
  tm: TmClient,
  handler: WorkHandler,
  opts: WorkOptions = {},
): Promise<WorkSummary> {
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const wants = matcher(opts.filter);
  const slots = semaphore(concurrency);
  const ackHandled = opts.ack ?? true;
  const onError =
    opts.onError ??
    ((e: unknown, ev: TmEvent): void =>
      void console.error(`[tm.work] ${ev.type} ${ev.ticket_key ?? ''}`, e));
  // Our own controller so a handler's `ctx.signal` also fires when the loop stops.
  const stopper = new AbortController();
  const onOuterAbort = (): void => stopper.abort(opts.signal?.reason);
  if (opts.signal?.aborted) stopper.abort(opts.signal.reason);
  else opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const summary: WorkSummary = { handled: 0, failed: 0, cursor: opts.cursor ?? null };
  const inFlight = new Set<Promise<void>>();
  /** Tickets with a handler running: the next event for one waits its turn. */
  const busy = new Map<string, Promise<void>>();

  const runOne = async (event: TmEvent): Promise<void> => {
    const ticket = event.ticket_key;
    const beat =
      opts.heartbeat === false
        ? null
        : deps.startBeat({
            ...(ticket ? { ticket } : {}),
            message: opts.heartbeat?.message ?? event.summary.slice(0, 200),
            ...(opts.heartbeat?.everyMs !== undefined ? { everyMs: opts.heartbeat.everyMs } : {}),
            onError: () => void 0, // a dropped beat must not fail the work
          });
    try {
      await handler({ event, ticket, tm, beat, signal: stopper.signal });
      summary.handled += 1;
      await beat?.done().catch(() => void 0);
      if (ackHandled) await deps.ack([event.id], { signal: stopper.signal }).catch(() => void 0);
    } catch (e) {
      summary.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      // The ticket must stop saying "working" even though nobody acked.
      await beat?.error(message.slice(0, 200)).catch(() => void 0);
      onError(e, event);
    } finally {
      beat?.stop();
    }
  };

  const source =
    (opts.transport ?? 'watch') === 'stream'
      ? deps.stream({ ...opts, ack: false, signal: stopper.signal })
      : watchEvents(deps, opts, stopper.signal);

  try {
    for await (const event of source) {
      summary.cursor = event.id;
      if (!wants(event)) continue;
      await slots.acquire();
      if (stopper.signal.aborted) {
        slots.release();
        break;
      }
      // One handler per ticket at a time.
      const key = event.ticket_key;
      const previous = key ? busy.get(key) : undefined;
      const task = (async (): Promise<void> => {
        if (previous) await previous.catch(() => void 0);
        await runOne(event);
      })().finally(() => {
        slots.release();
        if (key && busy.get(key) === task) busy.delete(key);
      });
      if (key) busy.set(key, task);
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
      if (opts.max !== undefined && summary.handled + summary.failed + inFlight.size >= opts.max)
        break;
    }
  } finally {
    opts.signal?.removeEventListener('abort', onOuterAbort);
    await Promise.all([...inFlight]);
    stopper.abort();
  }
  return summary;
}

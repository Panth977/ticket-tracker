/**
 * tm.watch() — the claim of §W, tested: an idle orchestrator costs nothing.
 *
 * The two numbers that matter, and the two tests that hold them:
 *   · a watcher that is streaming makes NO REST call while nothing changes
 *   · a change wakes it in well under a second — it is pushed, not found
 *
 * Everything here runs on a virtual clock, so "a minute" is a minute of the
 * SDK's own `sleep`, not a minute of the suite.
 */
import { describe, expect, it } from 'vitest';
import { createClient } from '../src/client.js';
import { pathsFor, revisionOf, type LiveCredential } from '../src/watch.js';
import type { Me } from '../src/types.js';

// ───────────────────────── a clock the test owns ─────────────────────────

interface Clock {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Run the SDK forward `ms` of ITS time, firing every sleep that comes due. */
  advance: (ms: number) => Promise<void>;
  /** Fire due sleeps one at a time, up to `until`, stopping when `done()` is true. */
  runUntil: (done: () => boolean, budgetMs: number) => Promise<void>;
  flush: () => Promise<void>;
}

function fakeClock(): Clock {
  let t = 0;
  let seq = 0;
  interface Waiter {
    id: number;
    at: number;
    resolve: () => void;
    reject: (e: unknown) => void;
    off?: () => void;
  }
  const waiters: Waiter[] = [];
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 64; i++) await Promise.resolve();
  };
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
      const w: Waiter = { id: ++seq, at: t + ms, resolve, reject };
      waiters.push(w);
      if (signal) {
        const onAbort = (): void => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(signal.reason ?? new Error('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        w.off = () => signal.removeEventListener('abort', onAbort);
      }
    });
  /** Fire the single earliest sleep that is due by `limit`. */
  const runNext = async (limit: number): Promise<boolean> => {
    await flush();
    const due = waiters.filter((w) => w.at <= limit).sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) return false;
    t = due.at;
    waiters.splice(waiters.indexOf(due), 1);
    due.off?.();
    due.resolve();
    await flush();
    return true;
  };
  const advance = async (ms: number): Promise<void> => {
    const target = t + ms;
    while (await runNext(target));
    t = target;
    await flush();
  };
  const runUntil = async (done: () => boolean, budgetMs: number): Promise<void> => {
    const target = t + budgetMs;
    await flush();
    while (!done() && (await runNext(target)));
    await flush();
  };
  return { now: () => t, sleep, advance, runUntil, flush };
}

// ───────────────────────── a fake RTDB + a counted API ─────────────────────

const DB = 'https://tm-test.asia-southeast1.firebasedatabase.app';
const CRED: LiveCredential = { database_url: DB, auth: 'fake-id-token' };

const ME: Me = {
  principal: {
    kind: 'agent',
    id: 'ag_1',
    name: 'Builder',
    email: null,
    avatar_url: null,
    icon: null,
  },
  owner: { id: 'u1', name: 'Panth', email: 'p@example.com' },
  kind: 'board',
  board: { id: 'b1', key: 'ENG', name: 'Engineering' },
  role: 'member',
  scopes: [],
  via: 'api',
} as unknown as Me;

/** One fetch serving both the RTDB stream and /v1, counting each separately. */
function wiring(opts: { rest?: (path: string) => unknown } = {}) {
  const rest: string[] = [];
  const opened: string[] = [];
  let push: ((chunk: string) => void) | null = null;
  let close: (() => void) | null = null;

  const impl = (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith(DB)) {
      opened.push(url);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          push = (chunk: string): void => controller.enqueue(enc.encode(chunk));
          close = (): void => {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          };
          init.signal?.addEventListener('abort', () => close?.(), { once: true });
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    const path = new URL(url).pathname.replace(/^\/v1/, '');
    rest.push(path);
    return new Response(JSON.stringify(opts.rest?.(path) ?? { data: [], has_more: false }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return {
    impl,
    rest,
    opened,
    /** Write one RTDB SSE frame down the open stream. */
    send: (event: string, data: unknown): void =>
      void push?.(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    end: (): void => void close?.(),
  };
}

describe('tm.watch — an idle orchestrator costs nothing (§W)', () => {
  it('makes NO REST call for a minute while nothing changes', async () => {
    const clock = fakeClock();
    const net = wiring();
    const tm = createClient({
      token: 't',
      baseUrl: 'http://tm.test/v1',
      fetch: net.impl,
      now: clock.now,
      sleep: clock.sleep,
      // The credential is in hand, so not even /v1/live is called.
      live: { ...CRED, paths: ['agents/ag_1/wake'] },
    });

    const w = tm.watch();
    const it = w[Symbol.asyncIterator]();
    // The first signal is 'open': drain whatever piled up while we were gone.
    expect(await it.next()).toMatchObject({ value: { reason: 'open' } });
    await clock.flush();
    // The RTDB replays the node's current value on connect. Not a change.
    net.send('put', { path: '/', data: { at: 1_000, boardId: 'b1' } });
    await clock.flush();

    const restAfterOpen = net.rest.length;
    await clock.advance(60_000);

    expect(w.source).toBe('stream');
    expect(net.opened).toHaveLength(1); // ONE connection, still the same one
    expect(net.rest.length - restAfterOpen).toBe(0); // …and not one REST call
    w.stop();
  });

  it('wakes within a second when the node moves', async () => {
    const clock = fakeClock();
    const net = wiring();
    const tm = createClient({
      token: 't',
      baseUrl: 'http://tm.test/v1',
      fetch: net.impl,
      now: clock.now,
      sleep: clock.sleep,
      live: { ...CRED, paths: ['agents/ag_1/wake'] },
    });
    const w = tm.watch();
    const it = w[Symbol.asyncIterator]();
    await it.next();
    await clock.flush();
    net.send('put', { path: '/', data: { at: 1_000 } });
    await clock.flush();

    const pending = it.next();
    let settled = false;
    void pending.then(() => (settled = true));
    // Nothing has changed yet, so nothing has arrived.
    await clock.advance(500);
    expect(settled).toBe(false);

    net.send('put', { path: '/', data: { at: 2_000, boardId: 'b1' } });
    await clock.advance(1_000);
    expect(settled).toBe(true);
    expect((await pending).value).toMatchObject({ reason: 'inbox', source: 'stream' });
    w.stop();
  });

  it('ignores the value the RTDB replays on every reconnect', async () => {
    const clock = fakeClock();
    const net = wiring();
    const tm = createClient({
      token: 't',
      baseUrl: 'http://tm.test/v1',
      fetch: net.impl,
      now: clock.now,
      sleep: clock.sleep,
      live: { ...CRED, paths: ['rev/b1'] },
    });
    const w = tm.watch();
    const it = w[Symbol.asyncIterator]();
    await it.next();
    await clock.flush();
    net.send('put', { path: '/', data: { at: 5_000, by: 'u1' } });
    await clock.flush();

    const pending = it.next();
    let settled = false;
    void pending.then(() => (settled = true));

    // The stream drops and comes back with the same value — a reconnect, not news.
    net.end();
    await clock.advance(2_000);
    net.send('put', { path: '/', data: { at: 5_000, by: 'u1' } });
    await clock.advance(1_000);
    expect(net.opened.length).toBeGreaterThan(1);
    expect(settled).toBe(false);

    // A genuinely newer revision does wake it, and says which board.
    net.send('put', { path: '/', data: { at: 6_000, by: 'u1' } });
    await clock.advance(100);
    expect((await pending).value).toMatchObject({ reason: 'board', board: 'b1' });
    w.stop();
  });
});

describe('tm.watch — polling is the fallback, on a backoff (§W)', () => {
  it('backs off from seconds to a minute when nothing is found, and snaps back', async () => {
    const clock = fakeClock();
    const net = wiring();
    const tm = createClient({
      token: 't',
      baseUrl: 'http://tm.test/v1',
      fetch: net.impl,
      now: clock.now,
      sleep: clock.sleep,
      live: false, // no streaming available at all
    });
    const w = tm.watch({ minPollMs: 2_000, maxPollMs: 60_000 });
    const it = w[Symbol.asyncIterator]();
    expect(await it.next()).toMatchObject({ value: { reason: 'open' } });
    expect(w.source).toBe('poll');
    expect(net.opened).toHaveLength(0);

    /** How long until the next poll signal arrives, in virtual millis? */
    const nextPollAt = async (budgetMs: number): Promise<number> => {
      const start = clock.now();
      const p = it.next();
      let at = -1;
      void p.then(() => (at = clock.now() - start));
      await clock.runUntil(() => at >= 0, budgetMs);
      await p;
      return at;
    };

    w.found(0);
    expect(await nextPollAt(120_000)).toBe(4_000); // 2 s doubled
    w.found(0);
    expect(await nextPollAt(120_000)).toBe(8_000);
    for (let i = 0; i < 6; i++) {
      w.found(0);
      await nextPollAt(120_000);
    }
    w.found(0);
    expect(await nextPollAt(120_000)).toBe(60_000); // capped at the minute

    w.found(3); // work arrived — be eager again
    expect(await nextPollAt(120_000)).toBe(2_000);
    w.stop();
  });

  it('asks the API for a credential once, and polls when there is no such route', async () => {
    const clock = fakeClock();
    const rest: string[] = [];
    const impl = (async (input: string) => {
      const path = new URL(String(input)).pathname.replace(/^\/v1/, '');
      rest.push(path);
      return new Response(JSON.stringify({ code: 'not_found', status: 404 }), {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      });
    }) as unknown as typeof fetch;
    const tm = createClient({
      token: 't',
      baseUrl: 'http://tm.test/v1',
      fetch: impl,
      retry: false,
      now: clock.now,
      sleep: clock.sleep,
    });
    const reasons: string[] = [];
    const w = tm.watch({ minPollMs: 1_000, onDegrade: (r) => reasons.push(r) });
    const it = w[Symbol.asyncIterator]();
    await it.next();
    await clock.advance(5_000);
    expect(rest.filter((p) => p === '/live')).toHaveLength(1); // asked ONCE
    expect(w.source).toBe('poll');
    expect(reasons[0]).toContain('no live credential');
    w.stop();
  });
});

describe('tm.watch — the pieces', () => {
  it('watches the agent inbox for an agent token and the board otherwise', () => {
    expect(pathsFor(ME, 'auto')).toEqual(['agents/ag_1/wake']);
    expect(pathsFor(ME, 'board')).toEqual(['rev/b1']);
    expect(pathsFor(ME, 'all')).toEqual(['agents/ag_1/wake', 'rev/b1']);
    const person = { ...ME, principal: { ...ME.principal, kind: 'user' } } as Me;
    expect(pathsFor(person, 'auto')).toEqual(['rev/b1']);
    // An account token has no wake node of its own: its boards are the signal.
    const account = {
      ...ME,
      principal: { ...ME.principal, kind: 'user' },
      kind: 'account',
      board: null,
      boards: [
        { id: 'b1', key: 'ENG', name: 'Engineering' },
        { id: 'b2', key: 'OPS', name: 'Ops' },
      ],
    } as unknown as Me;
    expect(pathsFor(account, 'inbox')).toEqual(['rev/b1', 'rev/b2']);
  });

  it('reads the revision out of whatever the RTDB put on the wire', () => {
    expect(revisionOf({ at: 12, by: 'u1' })).toBe(12);
    expect(revisionOf(12)).toBe(12);
    expect(revisionOf(null)).toBeNull();
    expect(revisionOf({ by: 'u1' })).toBeNull();
    // A put at a parent hands back its children — the newest one wins.
    expect(revisionOf({ b1: { at: 4 }, b2: { at: 9 } })).toBe(9);
  });
});

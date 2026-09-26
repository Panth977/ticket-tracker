/**
 * tm.work() — the orchestrator loop: heartbeat while the handler runs,
 * done / error at the end, ack only on success, and never two handlers on one
 * ticket at once.
 */
import { describe, expect, it } from 'vitest';
import { createClient } from '../src/client.js';
import type { TmEvent } from '../src/types.js';
import { anEvent, sseBody } from './helpers.js';

interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

const DB = 'https://tm-test.firebasedatabase.app';

/**
 * A client whose INBOX serves `events` once and then nothing.
 *
 * §W: work() waits on tm.watch() and then asks /v1/events for the delta, so
 * this serves a live credential and an RTDB stream that simply stays open —
 * the shape a real agent runs in. `transport: 'stream'` still goes to
 * /v1/events/stream, which is served too.
 */
function workClient(events: TmEvent[], opts: { live?: boolean } = {}) {
  const calls: Recorded[] = [];
  let streams = 0;
  let pages = 0;
  const impl = (async (url: string, init: RequestInit = {}) => {
    const raw = String(url);
    if (raw.startsWith(DB)) {
      // An open connection that never says anything: the idle steady state.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener(
            'abort',
            () => {
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            },
            { once: true },
          );
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    const u = new URL(raw);
    const path = u.pathname.replace(/^\/v1/, '');
    if (path === '/events/stream') {
      const body = streams++ === 0 ? sseBody(events.map((e) => ({ event: 'event', id: e.id, data: e }))) : sseBody([{ event: 'ping', data: '' }]);
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    calls.push({
      method: (init.method ?? 'GET').toUpperCase(),
      path,
      query: Object.fromEntries(u.searchParams),
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    if (path === '/live') {
      if (opts.live === false) return new Response(JSON.stringify({ code: 'not_found' }), { status: 404, headers: { 'content-type': 'application/problem+json' } });
      return new Response(JSON.stringify({ database_url: DB, auth: 'tok', paths: ['agents/ag_1/wake'] }), { headers: { 'content-type': 'application/json' } });
    }
    if (path === '/events') {
      const data = pages++ === 0 ? events : [];
      return new Response(JSON.stringify({ data, has_more: false, next_cursor: data.length ? data[data.length - 1]!.id : null }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, acked: 1 }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const tm = createClient({
    token: 't',
    baseUrl: 'http://tm.test/v1',
    fetch: impl,
    // Real waiting, but capped: the 15-minute backstop must not make the
    // suite take 15 minutes, and a no-op sleep would spin.
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(ms, 1_000));
        signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason ?? new Error('aborted'))), { once: true });
      }),
  });
  return {
    tm,
    calls,
    inbox: () => calls.filter((c) => c.path === '/events'),
    beats: () => calls.filter((c) => c.path === '/heartbeat'),
    acks: () => calls.filter((c) => c.path === '/events/ack'),
  };
}

describe('tm.work', () => {
  it('runs the handler, beats while it runs, finishes the beat and acks', async () => {
    const ev = anEvent({ id: 'ev1', ticket_key: 'ENG-1', summary: 'Assigned ENG-1' });
    const { tm, calls, beats, acks } = workClient([ev]);

    const seen: { ticket: string | null; type: string }[] = [];
    const summary = await tm.work(
      async ({ ticket, event, beat, tm: client }) => {
        seen.push({ ticket, type: event.type });
        await beat!.update({ message: 'Running tests (3/12)' });
        await client.messages.post(ticket!, { markdown: 'On it.' });
      },
      { max: 1, heartbeat: { everyMs: 60_000 } },
    );

    expect(summary).toMatchObject({ handled: 1, failed: 0, cursor: 'ev1' });
    expect(seen).toEqual([{ ticket: 'ENG-1', type: 'assigned' }]);

    const states = beats().map((b) => b.body);
    expect(states[0]).toMatchObject({ state: 'working', ticket: 'ENG-1', message: 'Assigned ENG-1' });
    expect(states[1]).toMatchObject({ state: 'working', message: 'Running tests (3/12)' });
    expect(states[states.length - 1]).toMatchObject({ state: 'done', ticket: 'ENG-1' });

    expect(calls.some((c) => c.path === '/tickets/ENG-1/messages')).toBe(true);
    expect(acks()[0]!.body).toEqual({ ids: ['ev1'] });
  });

  it('marks the beat error and does NOT ack when the handler throws', async () => {
    const { tm, beats, acks } = workClient([anEvent({ id: 'ev1', ticket_key: 'ENG-1' })]);
    const errors: unknown[] = [];
    const summary = await tm.work(
      async () => {
        throw new Error('tests failed');
      },
      { max: 1, onError: (e) => errors.push(e) },
    );
    expect(summary).toMatchObject({ handled: 0, failed: 1 });
    expect(beats()[beats().length - 1]!.body).toMatchObject({ state: 'error', message: 'tests failed' });
    expect(acks()).toHaveLength(0); // unacked, so the next run sees it again
    expect(errors).toHaveLength(1);
  });

  it('filters by event type', async () => {
    const { tm } = workClient([anEvent({ id: 'ev1', type: 'comment' }), anEvent({ id: 'ev2', type: 'assigned' })]);
    const types: string[] = [];
    await tm.work(async ({ event }) => void types.push(event.type), { filter: ['assigned'], max: 1 });
    expect(types).toEqual(['assigned']);
  });

  it('filters by predicate', async () => {
    const { tm } = workClient([anEvent({ id: 'ev1', ticket_key: 'ENG-1' }), anEvent({ id: 'ev2', ticket_key: 'OPS-9' })]);
    const tickets: (string | null)[] = [];
    await tm.work(async ({ ticket }) => void tickets.push(ticket), { filter: (e) => e.ticket_key?.startsWith('OPS') === true, max: 1 });
    expect(tickets).toEqual(['OPS-9']);
  });

  it('runs up to `concurrency` handlers at once', async () => {
    const events = ['ENG-1', 'ENG-2', 'ENG-3'].map((k, i) => anEvent({ id: `ev${i + 1}`, ticket_key: k }));
    const { tm } = workClient(events);
    let live = 0;
    let peak = 0;
    await tm.work(
      async () => {
        peak = Math.max(peak, ++live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
      },
      { concurrency: 3, max: 3, heartbeat: false },
    );
    expect(peak).toBe(3);
  });

  it('never runs two handlers on the SAME ticket at once', async () => {
    const events = [anEvent({ id: 'ev1', ticket_key: 'ENG-1' }), anEvent({ id: 'ev2', ticket_key: 'ENG-1' })];
    const { tm } = workClient(events);
    let live = 0;
    let peak = 0;
    await tm.work(
      async () => {
        peak = Math.max(peak, ++live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
      },
      { concurrency: 4, max: 2, heartbeat: false },
    );
    expect(peak).toBe(1);
  });

  it('sends no heartbeat when there is none to send', async () => {
    const { tm, beats } = workClient([anEvent({ id: 'ev1' })]);
    await tm.work(async ({ beat }) => void expect(beat).toBeNull(), { max: 1, heartbeat: false });
    expect(beats()).toHaveLength(0);
  });

  it('asks for the DELTA, not the world, and never opens the billed SSE stream (§W)', async () => {
    const { tm, inbox, calls } = workClient([anEvent({ id: 'ev1' })]);
    await tm.work(async () => void 0, { max: 1, heartbeat: false });
    const first = inbox()[0]!;
    // unacked=1 on every call: an acked event is, by definition, already done.
    expect(first.query.unacked).toBe('1');
    // …and no `limit=200` full scan of the inbox.
    expect(first.query.limit).toBeUndefined();
    expect(calls.some((c) => c.path === '/events/stream')).toBe(false);
    // The credential is asked for ONCE, not per wake.
    expect(calls.filter((c) => c.path === '/live')).toHaveLength(1);
  });

  it('resumes from the cursor it was given, so a restart is not a rescan', async () => {
    const { tm, inbox } = workClient([anEvent({ id: 'ev9' })]);
    await tm.work(async () => void 0, { max: 1, heartbeat: false, cursor: 'ev8' });
    expect(inbox()[0]!.query.cursor).toBe('ev8');
  });

  it('still runs on /v1/events/stream when asked for it by name', async () => {
    const { tm, calls } = workClient([anEvent({ id: 'ev1', ticket_key: 'ENG-1' })]);
    const seen: string[] = [];
    const summary = await tm.work(async ({ event }) => void seen.push(event.id), {
      max: 1,
      heartbeat: false,
      transport: 'stream',
    });
    expect(summary).toMatchObject({ handled: 1, cursor: 'ev1' });
    expect(seen).toEqual(['ev1']);
    expect(calls.some((c) => c.path === '/events')).toBe(false);
  });

  it('polls on a backoff when no live credential can be had', async () => {
    const { tm, calls } = workClient([anEvent({ id: 'ev1' })], { live: false });
    const summary = await tm.work(async () => void 0, { max: 1, heartbeat: false });
    expect(summary.handled).toBe(1);
    expect(calls.some((c) => c.path === '/live')).toBe(true);
    expect(calls.some((c) => c.path === '/events/stream')).toBe(false);
  });

  it('stops when its signal fires', async () => {
    const ctrl = new AbortController();
    const { tm } = workClient([anEvent({ id: 'ev1' }), anEvent({ id: 'ev2' })]);
    const handled: string[] = [];
    const summary = await tm.work(
      async ({ event }) => {
        handled.push(event.id);
        ctrl.abort();
      },
      { signal: ctrl.signal, heartbeat: false },
    );
    expect(handled).toEqual(['ev1']);
    expect(summary.handled).toBe(1);
  });

  it('gives the handler a signal that fires when the loop stops', async () => {
    const { tm } = workClient([anEvent({ id: 'ev1' })]);
    let sawSignal: AbortSignal | undefined;
    await tm.work(async ({ signal }) => void (sawSignal = signal), { max: 1, heartbeat: false });
    expect(sawSignal?.aborted).toBe(true); // aborted once the loop finished
  });

  it('can be told not to ack', async () => {
    const { tm, acks } = workClient([anEvent({ id: 'ev1' })]);
    await tm.work(async () => void 0, { max: 1, ack: false, heartbeat: false });
    expect(acks()).toHaveLength(0);
  });
});

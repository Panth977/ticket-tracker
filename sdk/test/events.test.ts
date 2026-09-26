/**
 * The event stream: frames off the wire, the cursor that survives a
 * reconnect, keep-alives that are not events, and `ack: true`.
 */
import { describe, expect, it } from 'vitest';
import { parseFrame, readSse } from '../src/sse.js';
import { createClient } from '../src/client.js';
import { anEvent, mockFetch, sseBody, testClient } from './helpers.js';
import type { TmEvent } from '../src/types.js';

const streamOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });

/** Same bytes, but handed over in little pieces — frames must survive that. */
const chunkedStream = (text: string, size: number): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, (i += size)));
    },
  });
};

describe('parseFrame', () => {
  it('reads event, id and data', () => {
    expect(parseFrame('event: event\nid: ev1\ndata: {"a":1}')).toEqual({ event: 'event', id: 'ev1', data: '{"a":1}', retry: null });
  });

  it('strips exactly one space after the colon, and joins multi-line data', () => {
    expect(parseFrame('data:  x\ndata: y')?.data).toBe(' x\ny');
  });

  it('ignores comments and blank blocks', () => {
    expect(parseFrame(': keep-alive')).toBeNull();
    expect(parseFrame('   ')).toBeNull();
  });

  it('reads the retry hint', () => {
    expect(parseFrame('event: ping\nretry: 1000')).toMatchObject({ event: 'ping', retry: 1000 });
  });
});

describe('readSse', () => {
  const body = sseBody([
    { event: 'ping', data: '' },
    { event: 'event', id: 'ev1', data: { id: 'ev1' } },
    { event: 'event', id: 'ev2', data: { id: 'ev2' } },
  ]);

  it('splits a stream into frames', async () => {
    const seen = [];
    for await (const f of readSse(streamOf(body))) seen.push(f);
    expect(seen.map((f) => f.event)).toEqual(['ping', 'event', 'event']);
    expect(seen[2]!.id).toBe('ev2');
  });

  it('survives frames split across chunks', async () => {
    const seen = [];
    for await (const f of readSse(chunkedStream(body, 7))) seen.push(f);
    expect(seen.map((f) => f.id)).toEqual([null, 'ev1', 'ev2']);
  });

  it('handles CRLF', async () => {
    const seen = [];
    for await (const f of readSse(streamOf(body.replace(/\n/g, '\r\n')))) seen.push(f);
    expect(seen).toHaveLength(3);
  });
});

/** A fetch that answers /events/stream with SSE and everything else as JSON. */
function streamingFetch(bodies: string[], onOther: (url: string, init: RequestInit) => Response = () => new Response('{}')) {
  const calls: { url: string; init: RequestInit }[] = [];
  let n = 0;
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (!String(url).includes('/events/stream')) return onOther(String(url), init);
    const text = bodies[Math.min(n++, bodies.length - 1)]!;
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  return { impl, calls, get connections() { return calls.filter((c) => c.url.includes('/events/stream')).length; } };
}

describe('events.stream', () => {
  it('yields events, skips keep-alives and resumes from the last id', async () => {
    const a = anEvent({ id: 'ev1' });
    const b = anEvent({ id: 'ev2' });
    const f = streamingFetch([
      sseBody([{ event: 'ping', data: '' }, { event: 'event', id: 'ev1', data: a }, { event: 'event', id: 'ev2', data: b }]),
      sseBody([{ event: 'event', id: 'ev3', data: anEvent({ id: 'ev3' }) }]),
    ]);
    const tm = createClient({ token: 't', baseUrl: 'http://tm.test/v1', fetch: f.impl, sleep: async () => void 0 });

    const seen: TmEvent[] = [];
    for await (const ev of tm.events.stream()) {
      seen.push(ev);
      if (seen.length === 3) break;
    }
    expect(seen.map((e) => e.id)).toEqual(['ev1', 'ev2', 'ev3']);
    // The server ends every stream at ~50 s; we reconnect from where we got to.
    expect(f.connections).toBe(2);
    expect(f.calls[1]!.url).toContain('cursor=ev2');
    expect((f.calls[1]!.init.headers as Record<string, string>)['last-event-id']).toBe('ev2');
    expect((f.calls[0]!.init.headers as Record<string, string>).accept).toBe('text/event-stream');
  });

  it('acks each event only once the consumer has come back for the next', async () => {
    // The ack runs after the `yield` resumes — i.e. when the body of the
    // caller's loop finished. Leave the loop mid-handler and it is NOT acked,
    // which is the point: the next run sees it again.
    const acked: string[][] = [];
    const f = streamingFetch(
      [
        sseBody([
          { event: 'event', id: 'ev1', data: anEvent({ id: 'ev1' }) },
          { event: 'event', id: 'ev2', data: anEvent({ id: 'ev2' }) },
        ]),
      ],
      (url, init) => {
        if (url.includes('/events/ack')) acked.push((JSON.parse(String(init.body)) as { ids: string[] }).ids);
        return new Response(JSON.stringify({ acked: 1 }));
      },
    );
    const tm = createClient({ token: 't', baseUrl: 'http://tm.test/v1', fetch: f.impl, sleep: async () => void 0 });
    for await (const ev of tm.events.stream({ ack: true })) if (ev.id === 'ev2') break;
    expect(acked).toEqual([['ev1']]);
  });

  it('stops when its signal fires', async () => {
    const ctrl = new AbortController();
    const f = streamingFetch([sseBody([{ event: 'event', id: 'ev1', data: anEvent({ id: 'ev1' }) }])]);
    const tm = createClient({ token: 't', baseUrl: 'http://tm.test/v1', fetch: f.impl, sleep: async () => void 0 });
    const seen: TmEvent[] = [];
    for await (const ev of tm.events.stream({ signal: ctrl.signal })) {
      seen.push(ev);
      ctrl.abort();
    }
    expect(seen).toHaveLength(1);
  });

  it('gives up on a 403 and keeps trying on a 503', async () => {
    const forbidden = (async () => new Response(JSON.stringify({ code: 'forbidden' }), { status: 403 })) as typeof fetch;
    const tm = createClient({ token: 't', baseUrl: 'http://tm.test/v1', fetch: forbidden, sleep: async () => void 0 });
    await expect(
      (async () => {
        for await (const _ of tm.events.stream()) break;
      })(),
    ).rejects.toMatchObject({ code: 'forbidden' });

    let tries = 0;
    const flaky = (async () => {
      tries++;
      return new Response('', { status: 503 });
    }) as typeof fetch;
    const tm2 = createClient({ token: 't', baseUrl: 'http://tm.test/v1', fetch: flaky, sleep: async () => void 0 });
    await expect(
      (async () => {
        for await (const _ of tm2.events.stream({ maxReconnects: 2 })) break;
      })(),
    ).rejects.toMatchObject({ status: 503 });
    expect(tries).toBe(3); // the first, then two reconnects
  });

  it('skips a frame it cannot parse instead of ending the loop', async () => {
    const f = streamingFetch([
      sseBody([
        { event: 'event', id: 'ev1', data: 'not json' },
        { event: 'event', id: 'ev2', data: anEvent({ id: 'ev2' }) },
      ]),
      sseBody([]),
    ]);
    const tm = createClient({ token: 't', baseUrl: 'http://tm.test/v1', fetch: f.impl, sleep: async () => void 0 });
    const seen: TmEvent[] = [];
    for await (const ev of tm.events.stream()) {
      seen.push(ev);
      break;
    }
    expect(seen.map((e) => e.id)).toEqual(['ev2']);
  });

  it('starts from the cursor it was given', async () => {
    const f = streamingFetch([sseBody([{ event: 'event', id: 'ev42', data: anEvent({ id: 'ev42' }) }])]);
    const tm = createClient({ token: 't', baseUrl: 'http://tm.test/v1', fetch: f.impl, sleep: async () => void 0 });
    for await (const _ev of tm.events.stream({ cursor: 'ev41' })) break;
    expect(f.calls[0]!.url).toContain('cursor=ev41');
    expect((f.calls[0]!.init.headers as Record<string, string>)['last-event-id']).toBe('ev41');
  });
});

describe('events.list', () => {
  it('reads a page and the has_more flag', async () => {
    const f = mockFetch({ body: { data: [anEvent()], next_cursor: 'ev1', has_more: true } });
    const page = await testClient(f).events.list({ limit: 1 });
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).toBe('ev1');
  });
});

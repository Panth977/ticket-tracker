/**
 * A fetch that never leaves the process: it records what the SDK sent and
 * answers with whatever the test queued.
 */
import { createClient, type ClientOptions } from '../src/client.js';
import type { TmEvent } from '../src/types.js';

export interface Call {
  method: string;
  /** The whole URL the SDK built. */
  url: string;
  /** Path after /v1, e.g. '/tickets/ENG-42'. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  /** The raw body string, for when the test cares about the encoding. */
  raw: string | undefined;
  /** The body exactly as fetch got it — a Blob or FormData for an upload. */
  sent: unknown;
}

export type Reply =
  | { status?: number; body?: unknown; headers?: Record<string, string>; text?: string }
  /** Throw instead of answering — a connection that never came up. */
  | { networkError: string }
  | ((call: Call, index: number) => Reply);

export interface MockFetch {
  (input: string, init?: RequestInit): Promise<Response>;
  calls: Call[];
  /** Queue answers, used in order; the last one repeats once the queue runs dry. */
  queue: (...replies: Reply[]) => void;
  last: () => Call;
}

const BASE = 'http://tm.test/v1';

export function mockFetch(...initial: Reply[]): MockFetch {
  const replies: Reply[] = [...initial];
  const calls: Call[] = [];

  const fn = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const raw = typeof init.body === 'string' ? init.body : undefined;
    const call: Call = {
      method: (init.method ?? 'GET').toUpperCase(),
      url: String(input),
      path: url.pathname.replace(/^\/v1/, ''),
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      body: raw ? safeJson(raw) : undefined,
      raw,
      sent: init.body,
    };
    calls.push(call);

    let reply = replies.length > 1 ? replies.shift()! : (replies[0] ?? { status: 200, body: {} });
    while (typeof reply === 'function') reply = reply(call, calls.length - 1);
    if ('networkError' in reply) throw new TypeError(reply.networkError);
    const status = reply.status ?? 200;
    const text = reply.text ?? JSON.stringify(reply.body ?? {});
    return new Response(status === 204 ? null : text, {
      status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  }) as MockFetch;

  fn.calls = calls;
  fn.queue = (...r: Reply[]) => void replies.push(...r);
  fn.last = () => calls[calls.length - 1]!;
  return fn;
}

const safeJson = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

/** A client wired to a mock fetch, with retries off and the clock in hand. */
export function testClient(fetchImpl: MockFetch, overrides: Partial<ClientOptions> = {}) {
  let keys = 0;
  return createClient({
    token: 'tm_live_test',
    baseUrl: BASE,
    fetch: fetchImpl as unknown as typeof fetch,
    retry: false,
    // No real waiting anywhere in the unit suite.
    sleep: async () => void 0,
    newIdempotencyKey: () => `idem-${++keys}`,
    ...overrides,
  });
}

/** The problem+json body the API answers failures with. */
export const problem = (code: string, status: number, detail?: string, extra: Record<string, unknown> = {}) => ({
  type: `https://taskmanager.app/problems/${code}`,
  title: code,
  status,
  code,
  ...(detail ? { detail } : {}),
  ...extra,
});

/** An SSE body, as /v1/events/stream writes it. */
export function sseBody(frames: { event?: string; id?: string; data?: unknown }[]): string {
  return frames
    .map((f) => {
      const lines: string[] = [];
      if (f.event) lines.push(`event: ${f.event}`);
      if (f.id) lines.push(`id: ${f.id}`);
      if (f.data !== undefined) lines.push(`data: ${typeof f.data === 'string' ? f.data : JSON.stringify(f.data)}`);
      return lines.join('\n') + '\n\n';
    })
    .join('');
}

let eventSeq = 0;
/** A PublicEvent, with only the fields a test cares about spelled out. */
export function anEvent(over: Partial<TmEvent> = {}): TmEvent {
  const n = ++eventSeq;
  return {
    id: `ev${String(n).padStart(4, '0')}`,
    type: 'assigned',
    board: { id: 'b1', key: 'ENG', name: 'Engineering' },
    ticket_id: 't1',
    ticket_key: 'ENG-1',
    message_id: null,
    actor: { id: 'u1', kind: 'user', name: 'Priya' },
    summary: 'Assigned ENG-1',
    created_at: '2026-09-23T10:00:00.000Z',
    acked_at: null,
    ...over,
  };
}

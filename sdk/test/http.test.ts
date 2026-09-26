/**
 * The three promises §M makes about the transport: rate limits and 5xx retry
 * with backoff, every write carries an idempotency key so a retry is still
 * one change, and errors come back typed.
 */
import { describe, expect, it, vi } from 'vitest';
import { backoffMs, queryString, randomId } from '../src/http.js';
import { codeForStatus, isTmError, retryAfterMs, type TmError } from '../src/errors.js';
import { mockFetch, problem, testClient } from './helpers.js';

describe('errors', () => {
  it('maps problem+json onto code, status and the body', async () => {
    const f = mockFetch({ status: 403, body: problem('forbidden', 403, 'Only editors can move tickets', { scopes: ['tickets:move'] }) });
    const err = await testClient(f)
      .tickets.move('ENG-1', 'QA')
      .catch((e: TmError) => e);
    expect(isTmError(err)).toBe(true);
    const e = err as TmError;
    expect(e.code).toBe('forbidden');
    expect(e.status).toBe(403);
    expect(e.problem?.title).toBe('forbidden');
    expect(e.message).toContain('Only editors can move tickets');
    expect(e.missingScopes).toEqual(['tickets:move']);
    expect(e.retryable).toBe(false);
  });

  it("keeps the problem's extension members in details", async () => {
    const f = mockFetch({ status: 422, body: problem('unprocessable', 422, 'Stage requires an estimate', { missing: ['estimate'] }) });
    const e = (await testClient(f).tickets.get('ENG-1').catch((x) => x)) as TmError;
    expect(e.details).toEqual({ missing: ['estimate'] });
  });

  it('falls back to the status when there is no problem body', async () => {
    const f = mockFetch({ status: 502, text: 'Bad Gateway', headers: { 'content-type': 'text/plain' } });
    const e = (await testClient(f).me().catch((x) => x)) as TmError;
    expect(e.code).toBe('internal');
    expect(e.status).toBe(502);
    expect(e.retryable).toBe(true);
  });

  it('calls a connection that never came up a network error', async () => {
    const f = mockFetch({ networkError: 'fetch failed' });
    const e = (await testClient(f).me().catch((x) => x)) as TmError;
    expect(e.code).toBe('network');
    expect(e.status).toBe(0);
    expect(e.retryable).toBe(true);
  });

  it('isTmError recognises an error from another copy of the SDK', () => {
    expect(isTmError({ name: 'TmError', code: 'forbidden' })).toBe(true);
    expect(isTmError({ name: 'TmError', code: 'nonsense' })).toBe(false);
    expect(isTmError(new Error('x'))).toBe(false);
  });

  it('codeForStatus covers the ones with no mapping', () => {
    expect(codeForStatus(404)).toBe('not_found');
    expect(codeForStatus(418)).toBe('invalid');
    expect(codeForStatus(504)).toBe('internal');
  });

  it('reads Retry-After as seconds or as a date', () => {
    expect(retryAfterMs('3', 0)).toBe(3000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs(null, 0)).toBeNull();
  });
});

describe('retry', () => {
  const retrying = (f: ReturnType<typeof mockFetch>, slept: number[] = []) =>
    testClient(f, { retry: { retries: 3, baseMs: 10, jitter: false }, sleep: async (ms) => void slept.push(ms) });

  it('retries a 429 and honours Retry-After', async () => {
    const slept: number[] = [];
    const f = mockFetch({ status: 429, body: problem('rate_limited', 429), headers: { 'retry-after': '2' } }, { body: { key: 'ENG-1' } });
    const t = await retrying(f, slept).tickets.get('ENG-1');
    expect(t.key).toBe('ENG-1');
    expect(f.calls).toHaveLength(2);
    expect(slept[0]).toBe(2000); // the server's ask wins over our backoff
  });

  it('retries 5xx and network failures, then gives up', async () => {
    const slept: number[] = [];
    const f = mockFetch({ status: 503, body: problem('unavailable', 503) });
    await expect(retrying(f, slept).me()).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.calls).toHaveLength(4); // 1 + 3 retries
    expect(slept).toEqual([10, 20, 40]);

    const f2 = mockFetch({ networkError: 'ECONNRESET' });
    await expect(retrying(f2).me()).rejects.toMatchObject({ code: 'network' });
    expect(f2.calls).toHaveLength(4);
  });

  it('never retries a 4xx that will say the same thing again', async () => {
    const f = mockFetch({ status: 400, body: problem('invalid', 400, 'no such stage') });
    await expect(retrying(f).tickets.move('ENG-1', 'Nope')).rejects.toMatchObject({ code: 'invalid' });
    expect(f.calls).toHaveLength(1);
  });

  it('is off when retry: false', async () => {
    const f = mockFetch({ status: 503, body: problem('unavailable', 503) });
    await expect(testClient(f).me()).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.calls).toHaveLength(1);
  });

  it('takes a per-call retry setting', async () => {
    const slept: number[] = [];
    const f = mockFetch({ status: 503, body: problem('unavailable', 503) }, { body: {} });
    await testClient(f, { sleep: async (ms) => void slept.push(ms) }).me({ retry: { retries: 1, baseMs: 5, jitter: false } });
    expect(f.calls).toHaveLength(2);
  });

  it('lets shouldRetry have the last word', async () => {
    const f = mockFetch({ status: 404, body: problem('not_found', 404) }, { body: { key: 'ENG-1' } });
    const t = await testClient(f, { sleep: async () => void 0, retry: { retries: 2, shouldRetry: (e) => e.code === 'not_found' } }).tickets.get('ENG-1');
    expect(t.key).toBe('ENG-1');
    expect(f.calls).toHaveLength(2);
  });

  it('backs off exponentially, capped, with jitter over [0, backoff]', () => {
    const cfg = { retries: 5, baseMs: 100, maxMs: 1000, jitter: false };
    expect(backoffMs(0, cfg, null)).toBe(100);
    expect(backoffMs(1, cfg, null)).toBe(200);
    expect(backoffMs(4, cfg, null)).toBe(1000); // capped
    expect(backoffMs(0, { ...cfg, jitter: true }, null, () => 0.5)).toBe(50);
    expect(backoffMs(0, cfg, 5_000)).toBe(5_000); // Retry-After is a floor
  });
});

describe('idempotency', () => {
  it('puts a key on every write and none on a read', async () => {
    const f = mockFetch({ body: {} });
    const tm = testClient(f);
    await tm.tickets.get('ENG-1');
    expect(f.last().headers['idempotency-key']).toBeUndefined();
    f.queue({ body: {} });
    await tm.tickets.create({ title: 'x' });
    expect(f.last().headers['idempotency-key']).toBe('idem-1');
  });

  it('reuses ONE key across the retries of one call', async () => {
    const f = mockFetch({ status: 503, body: problem('unavailable', 503) }, { status: 503, body: problem('unavailable', 503) }, { status: 201, body: {} });
    await testClient(f, { retry: { retries: 3, baseMs: 1, jitter: false }, sleep: async () => void 0 }).tickets.create({ title: 'once' });
    expect(f.calls).toHaveLength(3);
    const keys = new Set(f.calls.map((c) => c.headers['idempotency-key']));
    expect(keys.size).toBe(1); // a retried create is still one ticket
  });

  it('gives a different key to a different call', async () => {
    const f = mockFetch({ body: {} });
    const tm = testClient(f);
    await tm.messages.post('ENG-1', { markdown: 'a' });
    await tm.messages.post('ENG-1', { markdown: 'b' });
    expect(f.calls[0]!.headers['idempotency-key']).not.toBe(f.calls[1]!.headers['idempotency-key']);
  });

  it("takes the caller's key, so a retry across restarts is safe too", async () => {
    const f = mockFetch({ body: {} });
    await testClient(f).messages.post('ENG-1', { markdown: 'a' }, { idempotencyKey: 'run-7-step-2' });
    expect(f.last().headers['idempotency-key']).toBe('run-7-step-2');
  });

  it('randomId is unique and url-safe', () => {
    const ids = new Set(Array.from({ length: 200 }, randomId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9-]+$/);
  });
});

describe('abort and timeouts', () => {
  it('a caller signal aborts the request', async () => {
    const ctrl = new AbortController();
    // A fetch that behaves like a real one: it rejects when its signal fires.
    const impl = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as typeof fetch;
    const p = testClient(mockFetch({ body: {} }), { fetch: impl }).me({ signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
  });

  it('a request that never answers times out', async () => {
    vi.useFakeTimers();
    try {
      const impl = ((_u: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        })) as typeof fetch;
      const p = testClient(mockFetch({ body: {} }), { fetch: impl, timeoutMs: 1_000 })
        .me()
        .catch((e: TmError) => e);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(((await p) as TmError).code).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a client-wide signal aborts everything it does', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const impl = (() => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      return Promise.reject(e);
    }) as typeof fetch;
    await expect(testClient(mockFetch({ body: {} }), { fetch: impl, signal: ctrl.signal }).me()).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('queryString', () => {
  it('drops undefined and null, and escapes the rest', () => {
    expect(queryString({ a: 1, b: undefined, c: null, d: 'x y&z' })).toBe('?a=1&d=x%20y%26z');
    expect(queryString(undefined)).toBe('');
    expect(queryString({})).toBe('');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { FILE_ACCESS_ROUTE } from '@tm/shared';
import { createFileSource, type FileSourceDeps } from './source';

const TTL = 15 * 60 * 1000;

/** A file-access endpoint that answers whatever the test needs. */
function harness(over: Partial<FileSourceDeps> = {}) {
  let now = 1_000_000;
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith(FILE_ACCESS_ROUTE)) {
      const path = new URL(url, 'http://x').searchParams.get('path')!;
      return new Response(
        JSON.stringify({
          url: `https://storage.example/${path}?sig=abc`,
          bytesUrl: `/api/files/blob?path=${encodeURIComponent(path)}&exp=${now + TTL}&sig=mac`,
          expiresAt: now + TTL,
        }),
        { status: 200 },
      );
    }
    return new Response('# plan\nthe whole file', { status: 206 });
  });
  const deps: FileSourceDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    getToken: vi.fn(async () => 'tok'),
    now: () => now,
    ...over,
  };
  return { src: createFileSource(deps), deps, calls, fetchMock, tick: (ms: number) => (now += ms) };
}

const file = (path: string, size = 1_000) => ({ path, size, name: path.split('/').pop()! });

describe('file source', () => {
  it('asks the API for a URL, with the ID token, and reuses it', async () => {
    const h = harness();
    expect(await h.src.fileUrl('boards/b/tickets/t/f1/a.png')).toBe(
      'https://storage.example/boards/b/tickets/t/f1/a.png?sig=abc',
    );
    expect(await h.src.fileUrl('boards/b/tickets/t/f1/a.png')).toContain('storage.example');
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const init = h.calls[0]!.init as { headers: Record<string, string> };
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(h.calls[0]!.url).toBe(`${FILE_ACCESS_ROUTE}?path=boards%2Fb%2Ftickets%2Ft%2Ff1%2Fa.png`);
  });

  it('mints a fresh URL once the old one is about to expire', async () => {
    const h = harness();
    await h.src.fileUrl('p/a.png');
    h.tick(TTL - 30_000); // inside the skew window
    await h.src.fileUrl('p/a.png');
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes the token once on 401', async () => {
    const getToken = vi.fn(async (force?: boolean) => (force ? 'fresh' : 'stale'));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      return auth === 'Bearer fresh'
        ? new Response(JSON.stringify({ url: 'u', bytesUrl: 'b', expiresAt: 2_000_000 }), {
            status: 200,
          })
        : new Response('', { status: 401 });
    });
    const src = createFileSource({
      fetch: fetchMock as unknown as typeof fetch,
      getToken,
      now: () => 1_000_000,
    });
    expect(await src.fileUrl('p/a.png')).toBe('u');
    expect(getToken).toHaveBeenLastCalledWith(true);
  });

  it('reads text over a Range on the same-origin URL and reports truncation', async () => {
    const h = harness();
    const r = await h.src.fileText(file('boards/b/tickets/t/f1/plan.md', 9_000), 64);
    expect(r.text).toBe('# plan\nthe whole file');
    expect(r.truncated).toBe(true);
    const read = h.calls.at(-1)!;
    expect(read.url).toContain('/api/files/blob?');
    expect((read.init as { headers: Record<string, string> }).headers.range).toBe('bytes=0-63');
  });

  it('serves a smaller read from a bigger cached one, and never caches a failure', async () => {
    const h = harness();
    await h.src.fileText(file('p/plan.md', 4), 100);
    const before = h.fetchMock.mock.calls.length;
    const small = await h.src.fileText(file('p/plan.md', 4), 8);
    expect(small.text).toBe('# plan\nt');
    expect(small.truncated).toBe(true);
    expect(h.fetchMock).toHaveBeenCalledTimes(before);

    const refused = vi.fn(async () => new Response('', { status: 403 }));
    const bad = createFileSource({
      fetch: refused as unknown as typeof fetch,
      getToken: async () => 'tok',
      now: () => 1,
    });
    await expect(bad.fileText(file('p/x.md'), 10)).rejects.toThrow();
    expect(await bad.fileUrl('p/x.md')).toBeNull();
    // Two attempts, not one cached refusal.
    expect(refused.mock.calls.length).toBe(2);
  });
});

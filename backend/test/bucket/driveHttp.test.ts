/**
 * The Drive API v3 client (bucket.html §K) against a recorded-shape fetch:
 * the requests it makes (query, fields, resumable upload in chunks, ranges)
 * and how it reads Google's answers. No network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesSource, DriveAuthError, httpDrive } from '../../src/bucket/drive/api.js';

const file = (over: Record<string, unknown> = {}) => ({
  id: 'f1abcdef',
  name: 'a.txt',
  mimeType: 'text/plain',
  parents: ['root1'],
  size: '3',
  createdTime: '2026-10-18T00:00:00Z',
  modifiedTime: '2026-10-18T00:00:01Z',
  headRevisionId: 'rev123456',
  ...over,
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

afterEach(() => vi.unstubAllGlobals());

describe('httpDrive', () => {
  it('children: one query for several parents, untrashed, every page', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        const page = new URL(url).searchParams.get('pageToken');
        return json(
          page ? { files: [file({ id: 'f2abcdef' })] } : { files: [file()], nextPageToken: 'p2' },
        );
      }),
    );
    const d = httpDrive(async () => 'tok');
    const out = await d.children(['root1', "it's"]);
    expect(out.map((f) => f.id)).toEqual(['f1abcdef', 'f2abcdef']);
    expect(out[0]).toMatchObject({ size: 3, headRevisionId: 'rev123456', trashed: false });
    const q = new URL(calls[0]!).searchParams.get('q');
    expect(q).toBe("('root1' in parents or 'it\\'s' in parents) and trashed = false");
    expect(calls).toHaveLength(2);
  });

  it('get: null on 404; a 401 is a DriveAuthError (the link is dead)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { message: 'nope' } }, 404)),
    );
    expect(await httpDrive(async () => 't').get('x')).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { message: 'bad' } }, 401)),
    );
    await expect(httpDrive(async () => 't').children(['r'])).rejects.toBeInstanceOf(DriveAuthError);
  });

  it('create: a resumable session, then the bytes in 8 MiB chunks with Content-Range', async () => {
    const size = 8 * 1024 * 1024 + 5;
    const bytes = new Uint8Array(size);
    const seen: { url: string; method?: string; headers?: Record<string, string> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        seen.push({
          url,
          method: init.method,
          headers: init.headers as Record<string, string>,
        });
        if (url.includes('uploadType=resumable'))
          return new Response(null, { status: 200, headers: { location: 'https://up/session' } });
        const range = (init.headers as Record<string, string>)['content-range']!;
        return range.endsWith(`-${size - 1}/${size}`)
          ? json(file({ size: String(size) }))
          : new Response(null, { status: 308 });
      }),
    );
    const f = await httpDrive(async () => 't').create({
      id: 'reserved1',
      parentId: 'root1',
      name: 'big.bin',
      mime: 'application/octet-stream',
      source: bytesSource(bytes),
    });
    expect(f.size).toBe(size);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.headers!['x-upload-content-length']).toBe(String(size));
    expect(seen.slice(1).map((s) => s.headers!['content-range'])).toEqual([
      `bytes 0-${8 * 1024 * 1024 - 1}/${size}`,
      `bytes ${8 * 1024 * 1024}-${size - 1}/${size}`,
    ]);
  });

  it('download asks for a byte range; trash patches trashed=true', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        seen.push(init);
        return new Response('abc', {
          status: init.headers && 'range' in (init.headers as object) ? 206 : 200,
        });
      }),
    );
    const d = httpDrive(async () => 't');
    const s = await d.download('f1', { start: 0, end: 2 });
    let text = '';
    for await (const c of s) text += Buffer.from(c as Uint8Array).toString();
    expect(text).toBe('abc');
    expect((seen[0]!.headers as Record<string, string>).range).toBe('bytes=0-2');
    await d.trash('f1');
    expect(seen[1]!.method).toBe('PATCH');
    expect(seen[1]!.body).toBe('{"trashed":true}');
  });

  it('openUpload: a resumable session for the browser, with its origin and the reserved id', async () => {
    let init: RequestInit = {};
    let url = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, i: RequestInit = {}) => {
        url = u;
        init = i;
        return new Response(null, { status: 200, headers: { location: 'https://up/s1' } });
      }),
    );
    const session = await httpDrive(async () => 't').openUpload({
      create: { id: 'res1abc', parentId: 'p1', name: 'a.png' },
      mime: 'image/png',
      size: 10,
      origin: 'https://app.example',
    });
    expect(session).toBe('https://up/s1');
    expect(url).toContain('uploadType=resumable');
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h.origin).toBe('https://app.example');
    expect(h['x-upload-content-length']).toBe('10');
    expect(JSON.parse(init.body as string)).toMatchObject({ id: 'res1abc', parents: ['p1'] });
  });

  it('a dropped connection or a 503 is tried again', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n === 1)
          throw Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } });
        if (n === 2) return new Response('busy', { status: 503 });
        return json({ files: [file()] });
      }),
    );
    const out = await httpDrive(async () => 't').children(['root1']);
    expect(out).toHaveLength(1);
    expect(n).toBe(3);
  }, 20_000);

  it('an upload whose chunk is dropped resumes from what Drive has', async () => {
    const size = 8 * 1024 * 1024 + 10;
    const ranges: string[] = [];
    let dropped = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url.includes('uploadType=resumable'))
          return new Response(null, { status: 200, headers: { location: 'https://up/s' } });
        const range = (init.headers as Record<string, string>)['content-range']!;
        ranges.push(range);
        if (range === `bytes */${size}`)
          return new Response(null, {
            status: 308,
            headers: { range: `bytes=0-${8 * 1024 * 1024 - 1}` },
          });
        if (range.startsWith(`bytes ${8 * 1024 * 1024}-`) && !dropped) {
          dropped = true;
          throw Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } });
        }
        return range.endsWith(`-${size - 1}/${size}`)
          ? json(file({ size: String(size) }))
          : new Response(null, {
              status: 308,
              headers: { range: `bytes=0-${8 * 1024 * 1024 - 1}` },
            });
      }),
    );
    const f = await httpDrive(async () => 't').create({
      parentId: 'p',
      name: 'big.bin',
      mime: 'application/octet-stream',
      source: bytesSource(new Uint8Array(size)),
    });
    expect(f.size).toBe(size);
    expect(ranges).toEqual([
      `bytes 0-${8 * 1024 * 1024 - 1}/${size}`,
      `bytes ${8 * 1024 * 1024}-${size - 1}/${size}`,
      `bytes */${size}`,
      `bytes ${8 * 1024 * 1024}-${size - 1}/${size}`,
    ]);
  }, 20_000);
});

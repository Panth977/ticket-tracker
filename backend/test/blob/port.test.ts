/** The blob suite on the disk adapter, in a temp directory, plus its signed-URL door. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'tm-blob-'));
process.env.TM_BLOB_DIR = dir;
process.env.TM_BLOB = 'disk';

const { diskAdapter } = await import('../../src/blob/disk.js');
const { blobSuite } = await import('./suite.js');

blobSuite('disk', () => diskAdapter.bucket(), { signs: true, preconditions: true });

describe('blob: disk paths', () => {
  it('refuses names that would leave the bucket', () => {
    expect(() => diskAdapter.bucket().file('../etc/passwd')).toThrow(/Invalid object name/);
    expect(() => diskAdapter.bucket().file('/abs')).toThrow(/Invalid object name/);
    expect(() => diskAdapter.bucket('../x')).toThrow(/Invalid bucket name/);
  });
});

describe('blob: the /blob door serves signed URLs', () => {
  const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

  // createApp imports every command: slow on a busy machine (CI), so not the 5 s default.
  it('PUT through a signed write URL, GET (and a range) through a signed read URL', async () => {
    const { createApp } = await import('../../src/http/app.js');
    const app = await createApp();
    const file = diskAdapter.bucket().file('door/test page.html');
    const exp = Date.now() + 60_000;
    const [put] = await file.getSignedUrl({
      action: 'write',
      expires: exp,
      contentType: 'text/html',
    });
    const wrongType = await app.request(pathOf(put), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(wrongType.status).toBe(403);
    const ok = await app.request(pathOf(put), {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: '<h1>hi</h1>',
    });
    expect(ok.status).toBe(200);

    const [get] = await file.getSignedUrl({ action: 'read', expires: exp });
    const res = await app.request(pathOf(get));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>hi</h1>');
    // Same-origin HTML is fenced into an opaque origin.
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const part = await app.request(pathOf(get), { headers: { range: 'bytes=1-3' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('h1>');

    expect((await app.request(pathOf(get).replace(/sig=[^&]+/, 'sig=AAAA'))).status).toBe(403);
    const [old] = await file.getSignedUrl({ action: 'read', expires: Date.now() - 1 });
    expect((await app.request(pathOf(old))).status).toBe(403);
  }, 30_000);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

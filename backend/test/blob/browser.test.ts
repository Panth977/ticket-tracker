/**
 * The browser's Storage calls on a VM (doors/blob.ts /blob/o/…): uploads and
 * download URLs, each checked by the real storage.rules with the caller's
 * ID token — what the firebase/storage shim of the VM build talks to.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.TM_BLOB_DIR = mkdtempSync(join(tmpdir(), 'tm-blob-browser-'));
process.env.TM_BLOB = 'disk';
process.env.TM_DB = 'sqlite';
process.env.TM_DB_DIR = ':memory:';
process.env.TM_AUTH = 'local';

const { createApp } = await import('../../src/http/app.js');
const { identity } = await import('../../src/identity/index.js');
const { signInWithCustomToken } = await import('../../src/identity/local/flows.js');

let app: Awaited<ReturnType<typeof createApp>>;
let token: string;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

beforeAll(async () => {
  app = await createApp();
  const s = await signInWithCustomToken(await identity().createCustomToken('u1'));
  token = s.idToken;
});

const upload = (name: string, body: Uint8Array, type: string, auth = true, meta?: object) =>
  app.request(`/blob/o/default/${name}`, {
    method: 'POST',
    headers: {
      'content-type': type,
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
      ...(meta ? { 'x-tm-metadata': JSON.stringify(meta) } : {}),
    },
    body,
  });

describe('blob: the browser door (/blob/o)', () => {
  it('uploads what storage.rules allow, refuses the rest', async () => {
    const ok = await upload('users/u1/avatar/1.webp', PNG, 'image/webp', true, { a: 'b' });
    expect(ok.status).toBe(200);
    const meta = (await ok.json()) as { size: number; contentType: string; metadata: object };
    expect(meta).toMatchObject({ size: PNG.length, contentType: 'image/webp', metadata: { a: 'b' } });
    expect((await upload('users/u2/avatar/1.webp', PNG, 'image/webp')).status).toBe(403);
    expect((await upload('users/u1/avatar/2.webp', PNG, 'text/html')).status).toBe(403);
    expect((await upload('users/u1/avatar/3.webp', PNG, 'image/webp', false)).status).toBe(403);
    const err = (await (await upload('users/u2/avatar/1.webp', PNG, 'image/webp')).json()) as {
      error: { code: string };
    };
    expect(err.error.code).toBe('storage/unauthorized');
  });

  it('a download URL for a reader; the URL serves the bytes', async () => {
    const res = await app.request('/blob/o/default/users/u1/avatar/1.webp', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const bytes = await app.request(url.replace(/^https?:\/\/[^/]+/, ''));
    expect(bytes.status).toBe(200);
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(PNG);
    // Signed out: the rule wants a signed-in reader.
    expect((await app.request('/blob/o/default/users/u1/avatar/1.webp')).status).toBe(403);
    const missing = await app.request('/blob/o/default/users/u1/avatar/9.webp', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.status).toBe(404);
  });
});

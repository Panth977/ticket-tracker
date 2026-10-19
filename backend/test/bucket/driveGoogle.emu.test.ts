/**
 * The REAL-Google path of driveFor (bucket.html §K1) against a mocked Google:
 * a connection (sealed refresh token) → an access token → Drive calls. The
 * fake Drive never goes through here, which is how a client that broke on
 * `await` (a Proxy answering `.then`) reached production unseen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/runtime/firebase.js';
import { DRIVE_LINKS, driveFor, seal } from '../../src/bucket/drive/link.js';
import { setupEmulators, uniq } from '../harness/index.js';

setupEmulators();

const ENV = ['TM_DRIVE', 'TM_GOOGLE_CLIENT_ID', 'TM_GOOGLE_CLIENT_SECRET'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('driveFor with a real Google connection', () => {
  it('can be awaited, refreshes the token and calls Drive with it', async () => {
    delete process.env.TM_DRIVE;
    process.env.TM_GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com';
    process.env.TM_GOOGLE_CLIENT_SECRET = 'secret';
    const uid = uniq('u');
    await db()
      .collection(DRIVE_LINKS)
      .doc(uid)
      .set({
        email: 'me@gmail.com',
        refresh: seal('refresh-1'),
        scope: 'https://www.googleapis.com/auth/drive.file',
        fake: false,
        connectedAt: 1,
        updatedAt: 1,
        brokenAt: null,
      });
    const seen: { url: string; auth?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        seen.push({
          url,
          auth: (init.headers as Record<string, string> | undefined)?.authorization,
        });
        if (url.startsWith('https://oauth2.googleapis.com/token'))
          return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), {
            status: 200,
          });
        return new Response(
          JSON.stringify({
            id: 'folder123',
            name: 'Tickets',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['root'],
          }),
          { status: 200 },
        );
      }),
    );
    const d = await driveFor(uid);
    const f = await d.get('folder123');
    expect(f).toMatchObject({ id: 'folder123', name: 'Tickets' });
    expect(seen[0]!.url).toContain('oauth2.googleapis.com/token');
    expect(seen.at(-1)!.auth).toBe('Bearer at-1');
  });
});

/**
 * The VM server end to end, on one port: the web app as Firebase Hosting
 * would serve it (static first, then firebase.json's rewrites), /config.json,
 * the api, local sign-in, and the /live WebSocket enforcing firestore.rules.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tm-vm-'));
const web = join(dir, 'web');
mkdirSync(join(web, '_app', 'immutable'), { recursive: true });
writeFileSync(join(web, 'index.html'), '<!doctype html><title>app</title>');
writeFileSync(join(web, '_app', 'immutable', 'a.js'), 'export {}');
Object.assign(process.env, {
  TM_PLATFORM: 'vm',
  TM_DEV: '1',
  TM_DATA_DIR: join(dir, 'data'),
  TM_WEB_DIR: web,
  TM_QUEUE: 'memory',
  APP_URL: 'http://127.0.0.1',
});

/** A frame off the live wire (shape checked by the assertions). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Frame = Record<string, any>;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtures } from '@tm/shared/schema/fixtures';

const { startServer } = await import('../../src/server.js');
const { db } = await import('../../src/db/index.js');
const { localIdentity } = await import('../../src/identity/local/accounts.js');
const { signInWithPassword } = await import('../../src/identity/local/flows.js');

let srv: Awaited<ReturnType<typeof startServer>>;
let base = '';

beforeAll(async () => {
  srv = await startServer(0);
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(async () => {
  await srv?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('VM server, one port', () => {
  it('serves the web app like Firebase Hosting', async () => {
    const page = await fetch(`${base}/b/ENG`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>app</title>');
    const asset = await fetch(`${base}/_app/immutable/a.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${base}/../../etc/passwd`)).status).not.toBe(500);
  });

  it('serves /config.json and the api on the same port', async () => {
    expect(await (await fetch(`${base}/config.json`)).json()).toMatchObject({ platform: 'vm' });
    expect(await (await fetch(`${base}/api/_status`)).json()).toMatchObject({ ok: true });
    expect((await fetch(`${base}/identity/providers`)).status).toBe(200);
  });

  it('/live: signed-in reads go through firestore.rules', async () => {
    await localIdentity.createUser({
      uid: 'u_live',
      email: 'live@x.dev',
      password: 'secret-123',
      emailVerified: true,
    });
    await db()
      .doc('users/u_live')
      .set({ ...JSON.parse(JSON.stringify(fixtures.users)), email: 'live@x.dev' });
    await db()
      .doc('users/u_live/inbox/n1')
      .set(JSON.parse(JSON.stringify(fixtures.inbox)));
    const { idToken } = await signInWithPassword('live@x.dev', 'secret-123');

    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/live`);
    const frames: Frame[] = [];
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await new Promise((ok) => (ws.onopen = ok));
    const ask = async (msg: object) => {
      const id = String(Math.random());
      ws.send(JSON.stringify({ id, ...msg }));
      for (let i = 0; i < 100; i++) {
        const f = frames.find((x) => x.id === id);
        if (f) return f;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('no answer');
    };
    expect((await ask({ op: 'auth', token: idToken })).result).toEqual({ uid: 'u_live' });
    expect((await ask({ op: 'get', path: 'users/u_live/inbox/n1' })).ok).toBe(true);
    await ask({ op: 'listen', lid: 'x', q: { path: 'users/u_live/inbox' } });
    await db()
      .doc('users/u_live/inbox/n2')
      .set(JSON.parse(JSON.stringify(fixtures.inbox)));
    await new Promise((r) => setTimeout(r, 80));
    expect(frames.filter((f) => f.lid === 'x').at(-1).snap.docs).toHaveLength(2);
    expect((await ask({ op: 'get', path: 'users/someone/inbox/n1' })).error.code).toBe(
      'permission-denied',
    );
    ws.close();
  });

  it('/live: a refused token never leaves the socket running as signed out', async () => {
    const { idToken } = await signInWithPassword('live@x.dev', 'secret-123');
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/live`);
    const frames: Frame[] = [];
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await new Promise((ok) => (ws.onopen = ok));
    const ask = async (msg: object) => {
      const id = String(Math.random());
      ws.send(JSON.stringify({ id, ...msg }));
      for (let i = 0; i < 100; i++) {
        const f = frames.find((x) => x.id === id);
        if (f) return f;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('no answer');
    };
    // e.g. a laptop waking up: the socket reconnects with an expired token.
    expect((await ask({ op: 'auth', token: 'expired.or.bogus' })).error.code).toBe(
      'unauthenticated',
    );
    // Not "permission-denied" as an anonymous reader would get: the page must
    // re-authenticate, not conclude that users/{uid} is not there.
    expect((await ask({ op: 'get', path: 'users/u_live' })).error.code).toBe('unauthenticated');
    expect((await ask({ op: 'auth', token: idToken })).result).toEqual({ uid: 'u_live' });
    expect((await ask({ op: 'get', path: 'users/u_live' })).ok).toBe(true);
    // A bad refresh for a session already signed in keeps that session.
    expect((await ask({ op: 'auth', token: 'expired.or.bogus' })).error.code).toBe(
      'unauthenticated',
    );
    expect((await ask({ op: 'get', path: 'users/u_live' })).ok).toBe(true);
    ws.close();
  });
});

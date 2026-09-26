/**
 * api-core end to end under the emulators: real ID tokens → user middleware →
 * runner → ping; problem+json for every failure path; idempotency by clientId.
 */
import { describe, expect, it } from 'vitest';
import { auth, db } from '../../src/runtime/firebase.js';
import { claimIdempotency } from '../../src/runtime/idempotency.js';
import { paths } from '@tm/shared';
import {
  call,
  callRaw,
  createUser,
  devOutbox,
  fixedClock,
  ports,
  queue,
  refreshToken,
  request,
  setPorts,
  setupEmulators,
  uniq,
} from './index.js';

setupEmulators();

/** Tests that swap ports only make sense in-process (not over the wire with TM_API_URL). */
const inProcess = it.skipIf(!!process.env.TM_API_URL);

describe('ping', () => {
  it('answers a signed-in user end to end', async () => {
    const alice = await createUser({ name: 'Alice' });
    const res = await call(alice, 'ping', { echo: 'hi' });
    expect(res).toMatchObject({
      pong: true,
      actor: alice.uid,
      via: 'app',
      echo: 'hi',
      firestore: 'emulator',
    });
  });

  inProcess('uses the clock port for ctx.now', async () => {
    setPorts({ clock: fixedClock(1_700_000_000_000) });
    const u = await createUser();
    expect(await call(u, 'ping', {})).toMatchObject({ now: 1_700_000_000_000 });
  });
});

describe('problem+json', () => {
  it('401 without a token', async () => {
    const r = await callRaw(null, 'ping', {});
    expect(r.status).toBe(401);
    expect(r.headers.get('content-type')).toContain('application/problem+json');
    expect(r.body).toMatchObject({
      code: 'unauthenticated',
      status: 401,
      type: expect.stringContaining('/problems/unauthenticated'),
    });
  });

  it('401 with a garbage token', async () => {
    const r = await callRaw({ token: 'nope' } as never, 'ping', {});
    expect(r.status).toBe(401);
  });

  it('401 once refresh tokens are revoked (checkRevoked)', async () => {
    const u = await createUser();
    // Revocation is second-granular: make sure the token predates it.
    await new Promise((r) => setTimeout(r, 1100));
    await auth().revokeRefreshTokens(u.uid);
    await expect(call(u, 'ping', {})).rejects.toMatchObject({ code: 'unauthenticated' });
    await new Promise((r) => setTimeout(r, 1100));
    await refreshToken(u);
    await expect(call(u, 'ping', {})).resolves.toMatchObject({ pong: true });
  });

  it('404 for an unknown command, 400 for bad input and unknown keys', async () => {
    const u = await createUser();
    await expect(call(u, 'noSuchCommand', {})).rejects.toMatchObject({ code: 'not_found' });
    await expect(call(u, 'ping', { echo: 5 })).rejects.toMatchObject({ code: 'invalid' });
    const r = await callRaw(u, 'ping', { extra: true });
    expect(r.status).toBe(400);
    expect((r.body as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
  });

  it('400 for a non-JSON body, and GET is not a command', async () => {
    const u = await createUser();
    const bad = await request('/api/ping', {
      method: 'POST',
      headers: { authorization: `Bearer ${u.token}` },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    const get = await request('/api/ping', { headers: { authorization: `Bearer ${u.token}` } });
    expect(get.status).toBe(400);
  });

  it('404 problem for unknown routes; mount points exist', async () => {
    const r = await request('/nowhere');
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'not_found' });
    const s = await request('/api/_status');
    expect(s.body).toMatchObject({ ok: true, commands: expect.arrayContaining(['ping']) });
  });
});

describe('idempotency by clientId', () => {
  inProcess('a retried request replays the first answer', async () => {
    let t = 1_700_000_000_000;
    setPorts({ clock: { now: () => t++ } });
    const u = await createUser();
    const clientId = uniq('c');
    const a = await call(u, 'ping', { clientId, echo: 'first' });
    const b = await call(u, 'ping', { clientId, echo: 'first' });
    expect(b).toEqual(a); // same `now` — the handler did not run again
    const rec = (await db().doc(paths.idem(u.uid, clientId)).get()).data();
    expect(rec).toMatchObject({ command: 'ping', status: 'done' });
    // 24h TTL from the request's ctx.now (the pinned clock).
    expect(rec!.expiresAt.toMillis()).toBe(1_700_000_000_000 + 24 * 60 * 60 * 1000);
    // A different clientId is a different request.
    const c = await call(u, 'ping', { clientId: uniq('c'), echo: 'first' });
    expect(c).not.toEqual(a);
  });

  it('failed requests release the key; in-flight duplicates get 409', async () => {
    const u = await createUser();
    const clientId = uniq('c');
    await expect(call(u, 'ping', { clientId, echo: 7 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(call(u, 'ping', { clientId, echo: 'ok' })).resolves.toMatchObject({ echo: 'ok' });

    const busy = uniq('c');
    const claim = await claimIdempotency(u.uid, busy, 'ping', Date.now());
    expect(claim.kind).toBe('claimed');
    await expect(call(u, 'ping', { clientId: busy })).rejects.toMatchObject({ code: 'conflict' });
    await expect(claimIdempotency(u.uid, busy, 'other', Date.now())).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('adapters (dev fakes)', () => {
  it('email / push / whatsapp land in the dev outbox', async () => {
    const to = `${uniq('m')}@test.dev`;
    const { providerId } = await ports().email.send({
      to,
      subject: 'Hello',
      text: 'Body',
      tag: 'invite',
    });
    expect(providerId).toBeTruthy();
    const mail = await devOutbox('mail', { field: 'to', equals: to });
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ subject: 'Hello', tag: 'invite', from: expect.any(String) });

    const res = await ports().push.send(['tok-ok', 'unregistered-1'], {
      title: 't',
      body: 'b',
      url: '/t/ENG-1',
    });
    expect(res).toEqual([
      expect.objectContaining({ token: 'tok-ok', ok: true }),
      expect.objectContaining({ token: 'unregistered-1', ok: false, unregistered: true }),
    ]);

    const e164 = `+9199${Math.floor(Math.random() * 1e8)}`;
    await ports().whatsapp.sendTemplate(e164, 'otp', ['123456']);
    expect(await devOutbox('whatsapp', { field: 'to', equals: e164 })).toEqual([
      expect.objectContaining({ kind: 'template', template: 'otp', params: ['123456'] }),
    ]);
  });

  inProcess('queue is the in-memory queue with name dedupe', async () => {
    await ports().queue.enqueue(
      'email',
      { to: 'a@b.c', template: 'x', params: {} },
      { name: 'n1' },
    );
    await ports().queue.enqueue(
      'email',
      { to: 'a@b.c', template: 'x', params: {} },
      { name: 'n1' },
    );
    expect(queue().pending()).toHaveLength(1);
  });
});

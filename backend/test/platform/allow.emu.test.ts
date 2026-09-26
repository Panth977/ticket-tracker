/**
 * PHASE 16 (docs/plan/agents.html §X) — WHOSE APP THIS IS.
 *
 * TaskManager is private: signing in is open, DOING anything is not. What is
 * proved here:
 *
 *   1. Only the admin — one address, from configuration — can see or change
 *      the list, and the admin is on it by definition and cannot be removed.
 *   2. An account that is not on the list is refused with a SPECIFIC error
 *      (forbidden + reason 'notAllowed' + who to ask), never a bare 403.
 *   3. An address can be allowed BEFORE that person has ever signed in, and
 *      the sign-up trigger mirrors the flag onto users/{uid}.allowed, which is
 *      what the security rules read.
 *   4. Taking access away bites on the next request — the app door and the
 *      token path both, so an orchestrator stops with its owner.
 *
 * HOW THIS FILE STAYS OUT OF EVERY OTHER SUITE'S WAY. Test files share one
 * emulator, and an allow list is global by nature. So this suite owns its own
 * list document (TM_ALLOW_DOC) and its own admin address (TM_ADMIN_EMAIL), and
 * turns on TM_ALLOW_STRICT — which switches off the emulator convenience that
 * lets an address the list does not name through, i.e. gives this process
 * exactly the production behaviour — only inside the tests that need it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paths, type User } from '@tm/shared';
import { auth, db } from '../../src/runtime/firebase.js';
import { handleUserCreated } from '../../src/triggers/authUserCreated.js';
import {
  call,
  callRaw,
  createUser,
  refreshToken,
  setupEmulators,
  uniq,
  type TestUser,
} from '../harness/index.js';
import { seedBoard } from '../tickets/helpers.js';
import { apiKeyFor, rest } from './helpers.js';

setupEmulators();

const ALLOW_DOC = `_config/allowTest_${uniq()}`;
const previous = { doc: process.env.TM_ALLOW_DOC, admin: process.env.TM_ADMIN_EMAIL };

let admin: TestUser;
let stranger: TestUser;

/** Production behaviour for the body of one test, and only there. */
async function strict<T>(fn: () => Promise<T>): Promise<T> {
  process.env.TM_ALLOW_STRICT = '1';
  try {
    return await fn();
  } finally {
    delete process.env.TM_ALLOW_STRICT;
  }
}

const profile = async (uid: string): Promise<User | undefined> =>
  (await db().doc(paths.user(uid)).get()).data() as User | undefined;

/** Wait for the sign-up trigger (the functions emulator runs it) to land. */
async function waitForProfile(uid: string, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await db().doc(paths.user(uid)).get()).exists) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  admin = await createUser({ name: 'Panth' });
  stranger = await createUser({ name: 'Stranger' });
  process.env.TM_ALLOW_DOC = ALLOW_DOC;
  process.env.TM_ADMIN_EMAIL = admin.email;
});

afterAll(async () => {
  process.env.TM_ALLOW_DOC = previous.doc ?? '';
  if (!previous.doc) delete process.env.TM_ALLOW_DOC;
  process.env.TM_ADMIN_EMAIL = previous.admin ?? '';
  if (!previous.admin) delete process.env.TM_ADMIN_EMAIL;
  delete process.env.TM_ALLOW_STRICT;
  await db().doc(ALLOW_DOC).delete();
});

describe('the list', () => {
  it('is the admin’s alone — and the admin is on it by definition', async () => {
    const r = await call(admin, 'userList', {});
    expect(r.admin).toBe(admin.email);
    expect(r.users[0]).toMatchObject({ email: admin.email, admin: true, addedBy: 'config' });
    expect(r.users[0]!.uid).toBe(admin.uid);
    // Signed in, not the admin: nothing to see and nothing to change.
    await expect(call(stranger, 'userList', {})).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(stranger, 'userAllow', { email: 'someone@example.com' }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(call(stranger, 'userDisallow', { email: admin.email })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('cannot lose its admin — not even to the admin', async () => {
    await expect(call(admin, 'userDisallow', { email: admin.email })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      call(admin, 'userAllow', { email: admin.email.toUpperCase() }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    const r = await call(admin, 'userList', {});
    expect(r.users.filter((u) => u.admin)).toHaveLength(1);
  });

  it('refuses to remove an address that is not on it', async () => {
    await expect(
      call(admin, 'userDisallow', { email: `nobody.${uniq()}@test.dev` }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('an address, before anyone has signed in with it', () => {
  it('is added by the admin, and the sign-up trigger mirrors the flag', async () => {
    const email = `later.${uniq()}@test.dev`;
    const added = await call(admin, 'userAllow', { email, note: 'Priya, design' });
    const row = added.users.find((u) => u.email === email);
    expect(row).toMatchObject({ uid: null, name: null, lastSignInAt: null, note: 'Priya, design' });
    expect(row!.addedBy).toBe(admin.uid);

    // They sign in for the first time.
    const priya = await createUser({ email });
    await waitForProfile(priya.uid);
    await handleUserCreated(await auth().getUser(priya.uid));
    expect((await profile(priya.uid))?.allowed).toBe(true);

    // And now the list knows who they are, without a document to keep in step.
    const r = await call(admin, 'userList', {});
    expect(r.users.find((u) => u.email === email)).toMatchObject({ uid: priya.uid });
    expect(r.users.find((u) => u.email === email)!.lastSignInAt).toBeGreaterThan(0);
  });

  it('a sign-up the list does not name is mirrored as refused', async () => {
    const outsider = await createUser({ name: 'Outsider' });
    await waitForProfile(outsider.uid);
    const rec = await auth().getUser(outsider.uid);
    await strict(() => handleUserCreated(rec));
    expect((await profile(outsider.uid))?.allowed).toBe(false);
  });
});

describe('the app door', () => {
  it('refuses an account that is not allowed, and says exactly why', async () => {
    const res = await strict(() => callRaw(stranger, 'ping', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'forbidden', reason: 'notAllowed', admin: admin.email });
    expect(String((res.body as { detail?: string }).detail)).toContain(admin.email);
  });

  it('lets the admin and everyone they allow through', async () => {
    const guest = await createUser({ name: 'Guest' });
    await strict(async () => {
      await expect(callRaw(guest, 'ping', {})).resolves.toMatchObject({ status: 403 });
      await call(admin, 'userAllow', { email: guest.email });
      await expect(callRaw(guest, 'ping', {})).resolves.toMatchObject({ status: 200 });
      await expect(callRaw(admin, 'ping', {})).resolves.toMatchObject({ status: 200 });
    });
  });

  it('takes access away on the next request', async () => {
    const leaver = await createUser({ name: 'Leaver' });
    await call(admin, 'userAllow', { email: leaver.email });
    await strict(async () => {
      expect((await callRaw(leaver, 'ping', {})).status).toBe(200);
      await call(admin, 'userDisallow', { email: leaver.email });
      // The very next request is refused. Their sessions are revoked too, so
      // depending on how recently the token was minted this is either "sign in
      // again" (401) or the allow list saying no (403) — never a 200.
      const next = await callRaw(leaver, 'ping', {});
      expect([401, 403]).toContain(next.status);
      // And signing in again does not help: the list is the answer, not the session.
      const back = await refreshToken(leaver);
      const res = await callRaw(back, 'ping', {});
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ reason: 'notAllowed' });
    });
    expect((await profile(leaver.uid))?.allowed).toBe(false);
  });
});

describe('tokens', () => {
  it('stop working when their owner is no longer allowed', async () => {
    const owner = await createUser({ name: 'Owner' });
    await call(admin, 'userAllow', { email: owner.email });
    const board = await seedBoard({ admin: owner });
    const { key } = await apiKeyFor(owner, ['tickets:read'], board.id);

    await strict(async () => {
      expect((await rest(key, 'GET', '/v1/me')).status).toBe(200);
      await call(admin, 'userDisallow', { email: owner.email });
      const res = await rest(key, 'GET', '/v1/me');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ reason: 'notAllowed' });
    });
  });
});

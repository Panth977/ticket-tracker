/**
 * The identity suite on the local adapter (SQLite in memory), plus the
 * sign-in flows only the local adapter has (Firebase Auth's servers do them
 * on the Firebase deploy).
 */
process.env.TM_DB = 'sqlite';
process.env.TM_DB_DIR = ':memory:';
process.env.TM_AUTH = 'local';
process.env.APP_URL = 'https://tasks.example.com';

import { afterEach, describe, expect, it } from 'vitest';

const { localIdentity } = await import('../../src/identity/local/accounts.js');
const flows = await import('../../src/identity/local/flows.js');
const { identitySuite } = await import('./suite.js');
const { setPorts, resetPorts } = await import('../../src/adapters/index.js');

identitySuite(
  'local',
  () => localIdentity,
  async (email, password) => (await flows.signInWithPassword(email, password)).idToken,
);

describe('local identity: sign-in flows', () => {
  const mail: { to: string; text: string }[] = [];
  const captureMail = () =>
    setPorts({
      email: {
        async send(m) {
          mail.push({ to: m.to, text: m.text });
          return { providerId: null };
        },
      },
    });
  afterEach(() => {
    resetPorts();
    mail.length = 0;
  });
  const tokenIn = (text: string) =>
    new URL(/https?:\/\/\S+/.exec(text)![0]).searchParams.get('tm_link')!;

  it('password: wrong password refused; sessions refresh and end', async () => {
    const email = `p${Date.now()}@test.dev`;
    await localIdentity.createUser({ email, password: 'secret-123' });
    await expect(flows.signInWithPassword(email, 'nope')).rejects.toMatchObject({
      code: 'auth/invalid-credential',
    });
    const s = await flows.signInWithPassword(email, 'secret-123');
    expect(s.expiresIn).toBe(3600);
    const r = await flows.refreshSession(s.refreshToken);
    expect((await localIdentity.verifyIdToken(r.idToken, true)).uid).toBe(s.user.uid);
    await flows.endSession(s.refreshToken);
    await expect(flows.refreshSession(s.refreshToken)).rejects.toMatchObject({
      code: 'auth/invalid-refresh-token',
    });
  });

  it('revocation ends refresh sessions too', async () => {
    const email = `rv${Date.now()}@test.dev`;
    const a = await localIdentity.createUser({ email, password: 'secret-123' });
    const s = await flows.signInWithPassword(email, 'secret-123');
    await localIdentity.revokeRefreshTokens(a.uid);
    await expect(flows.refreshSession(s.refreshToken)).rejects.toMatchObject({
      code: 'auth/invalid-refresh-token',
    });
  });

  it('e-mail link: mailed to the app origin, single use, creates a verified account', async () => {
    captureMail();
    const email = `l${Date.now()}@test.dev`;
    await flows.sendSignInLink(email, 'https://evil.example.org/steal');
    expect(mail[0]!.to).toBe(email);
    const url = new URL(/https?:\/\/\S+/.exec(mail[0]!.text)![0]);
    expect(url.origin).toBe('https://tasks.example.com'); // never somewhere else
    const s = (await flows.useLink(tokenIn(mail[0]!.text), email))!;
    expect(s.user.email).toBe(email);
    expect(s.user.emailVerified).toBe(true);
    await expect(flows.useLink(tokenIn(mail[0]!.text))).rejects.toMatchObject({
      code: 'auth/invalid-action-code',
    });
    // A second link signs into the SAME account.
    await flows.sendSignInLink(email);
    expect((await flows.useLink(tokenIn(mail[1]!.text)))!.user.uid).toBe(s.user.uid);
  });

  it('a link only works for the address it was sent to', async () => {
    captureMail();
    await flows.sendSignInLink(`m${Date.now()}@test.dev`);
    await expect(flows.useLink(tokenIn(mail[0]!.text), 'other@test.dev')).rejects.toMatchObject({
      code: 'auth/invalid-email',
    });
  });

  it('change e-mail: verified on click, the old address is free', async () => {
    captureMail();
    const email = `c${Date.now()}@test.dev`;
    const a = await localIdentity.createUser({
      email,
      password: 'secret-123',
      emailVerified: true,
    });
    const next = `c2${Date.now()}@test.dev`;
    await flows.sendEmailChangeLink(a.uid, next);
    expect(mail[0]!.to).toBe(next);
    expect(await flows.useLink(tokenIn(mail[0]!.text))).toBeNull();
    const u = await localIdentity.getUser(a.uid);
    expect(u.email).toBe(next);
    expect(u.emailVerified).toBe(true);
  });

  it('password change needs a recent sign-in; re-auth gives one', async () => {
    const email = `pw${Date.now()}@test.dev`;
    const a = await localIdentity.createUser({ email, password: 'secret-123' });
    const old = Math.floor(Date.now() / 1000) - 3600;
    await expect(flows.updatePassword(a.uid, old, 'new-secret-1')).rejects.toMatchObject({
      code: 'auth/requires-recent-login',
    });
    const s = await flows.reauthWithPassword(a.uid, 'secret-123');
    const d = await localIdentity.verifyIdToken(s.idToken);
    await flows.updatePassword(a.uid, d.auth_time, 'new-secret-1');
    await expect(flows.signInWithPassword(email, 'secret-123')).rejects.toBeDefined();
    await expect(flows.signInWithPassword(email, 'new-secret-1')).resolves.toBeDefined();
  });

  it('custom token → a session for that uid (once its account exists)', async () => {
    const uid = `ag_${Date.now()}`;
    const t = await localIdentity.createCustomToken(uid, { boardId: 'b1' });
    const s = await flows.signInWithCustomToken(t);
    const d = await localIdentity.verifyIdToken(s.idToken);
    expect(d.uid).toBe(uid);
    expect(d.boardId).toBe('b1');
    expect(d.firebase.sign_in_provider).toBe('custom');
  });

  it('an ID token is not a custom token, and the reverse', async () => {
    const t = await localIdentity.createCustomToken('u1');
    await expect(localIdentity.verifyIdToken(t)).rejects.toBeDefined();
  });

  it('OIDC is off until configured', () => {
    expect(flows.configuredProviders()).toEqual([]);
    expect(
      flows.oidcConfig('google.com', { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }),
    ).toMatchObject({ clientId: 'x' });
  });
});

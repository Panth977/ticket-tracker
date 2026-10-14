/**
 * THE IDENTITY PORT CONFORMANCE SUITE — one set of expectations, run on
 * every adapter:
 *
 *   test/identity/port.test.ts      local (SQLite in memory)
 *   test/identity/port.emu.test.ts  Firebase Auth on the emulator (the reference)
 */
import { describe, expect, it } from 'vitest';
import type { Identity } from '../../src/identity/types.js';

let n = 0;
const uniq = (p: string) =>
  `${p}${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function identitySuite(
  label: string,
  id: () => Identity,
  /** Sign in with a password, answering an ID token (emulator REST / local flow). */
  signIn: (email: string, password: string) => Promise<string>,
): void {
  describe(`identity port: ${label}`, () => {
    it('createUser / getUser / getUserByEmail (case-insensitive) / getUsers', async () => {
      const email = `${uniq('a')}@Test.DEV`;
      const rec = await id().createUser({
        email,
        password: 'secret-123',
        displayName: 'Ann',
        emailVerified: true,
      });
      expect(rec.uid).toBeTruthy();
      expect(rec.email).toBe(email.toLowerCase());
      expect(rec.emailVerified).toBe(true);
      expect(rec.displayName).toBe('Ann');
      expect(rec.disabled).toBe(false);
      expect(Date.parse(rec.metadata.creationTime)).toBeGreaterThan(Date.now() - 600_000);
      expect((await id().getUser(rec.uid)).email).toBe(email.toLowerCase());
      expect((await id().getUserByEmail(email.toUpperCase())).uid).toBe(rec.uid);
      const { users, notFound } = await id().getUsers([
        { email: email.toLowerCase() },
        { email: `${uniq('none')}@test.dev` },
      ]);
      expect(users.map((u) => u.uid)).toEqual([rec.uid]);
      expect(notFound).toHaveLength(1);
    });

    it('a chosen uid; duplicates refused with Firebase codes', async () => {
      const uid = uniq('u');
      const email = `${uniq('b')}@test.dev`;
      await id().createUser({ uid, email });
      await expect(id().createUser({ uid })).rejects.toMatchObject({
        code: 'auth/uid-already-exists',
      });
      await expect(id().createUser({ email })).rejects.toMatchObject({
        code: 'auth/email-already-exists',
      });
    });

    it('missing users: auth/user-not-found', async () => {
      await expect(id().getUser(uniq('nope'))).rejects.toMatchObject({
        code: 'auth/user-not-found',
      });
      await expect(id().getUserByEmail(`${uniq('nope')}@test.dev`)).rejects.toMatchObject({
        code: 'auth/user-not-found',
      });
      await expect(id().deleteUser(uniq('nope'))).rejects.toMatchObject({
        code: 'auth/user-not-found',
      });
    });

    it('updateUser: name, e-mail (frees the old address), disabled', async () => {
      const a = await id().createUser({ email: `${uniq('c')}@test.dev`, displayName: 'C' });
      const newEmail = `${uniq('c2')}@test.dev`;
      const u = await id().updateUser(a.uid, { displayName: 'C two', email: newEmail });
      expect(u.displayName).toBe('C two');
      expect(u.email).toBe(newEmail);
      expect((await id().getUserByEmail(newEmail)).uid).toBe(a.uid);
      await id().createUser({ email: a.email! }); // the old address is free again
      expect((await id().updateUser(a.uid, { disabled: true })).disabled).toBe(true);
    });

    it('deleteUser', async () => {
      const a = await id().createUser({ email: `${uniq('d')}@test.dev` });
      await id().deleteUser(a.uid);
      await expect(id().getUser(a.uid)).rejects.toMatchObject({ code: 'auth/user-not-found' });
      await id().createUser({ email: a.email! });
    });

    it('verifyIdToken: uid, email, email_verified, provider; garbage refused', async () => {
      const email = `${uniq('e')}@test.dev`;
      const a = await id().createUser({ email, password: 'secret-123', emailVerified: true });
      const token = await signIn(email, 'secret-123');
      const d = await id().verifyIdToken(token, true);
      expect(d.uid).toBe(a.uid);
      expect(d.email).toBe(email);
      expect(d.email_verified).toBe(true);
      expect(d.firebase.sign_in_provider).toBe('password');
      expect(typeof d.auth_time).toBe('number');
      await expect(id().verifyIdToken('not.a.token')).rejects.toBeDefined();
      await expect(id().verifyIdToken(`${token.slice(0, -4)}AAAA`)).rejects.toBeDefined();
    });

    it('revokeRefreshTokens: old tokens refused with checkRevoked, a new sign-in works', async () => {
      const email = `${uniq('r')}@test.dev`;
      const a = await id().createUser({ email, password: 'secret-123', emailVerified: true });
      const old = await signIn(email, 'secret-123');
      await new Promise((r) => setTimeout(r, 1100)); // revocation has second resolution
      await id().revokeRefreshTokens(a.uid);
      await expect(id().verifyIdToken(old, true)).rejects.toMatchObject({
        code: 'auth/id-token-revoked',
      });
      await new Promise((r) => setTimeout(r, 1100));
      const fresh = await signIn(email, 'secret-123');
      await expect(id().verifyIdToken(fresh, true)).resolves.toMatchObject({ uid: a.uid });
    });

    it('a disabled account: checkRevoked refuses its token', async () => {
      const email = `${uniq('x')}@test.dev`;
      const a = await id().createUser({ email, password: 'secret-123' });
      const token = await signIn(email, 'secret-123');
      await id().updateUser(a.uid, { disabled: true });
      await expect(id().verifyIdToken(token, true)).rejects.toMatchObject({
        code: 'auth/user-disabled',
      });
    });

    it('createCustomToken answers a token', async () => {
      const t = await id().createCustomToken(uniq('ag_'), { agent: true });
      expect(t.split('.')).toHaveLength(3);
    });
  });
}

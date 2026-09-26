/**
 * Test users: real Auth-emulator accounts with real (emulator) ID tokens, so
 * the `user` middleware runs exactly as in production.
 */
import { auth } from '../../src/runtime/firebase.js';
import { AUTH_HOST } from './env.js';

export interface TestUser {
  uid: string;
  email: string;
  displayName: string;
  password: string;
  /** A fresh ID token (minted at creation; call refreshToken() after claims change / revocation tests). */
  token: string;
}

let counter = 0;
/** A short unique suffix for ids / emails, so parallel test files never collide. */
export function uniq(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Sign in against the Auth emulator's REST API and return the ID token. */
export async function mintIdToken(email: string, password: string): Promise<string> {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const json = (await res.json()) as { idToken?: string; error?: { message: string } };
  if (!res.ok || !json.idToken)
    throw new Error(`mintIdToken(${email}): ${json.error?.message ?? res.status}`);
  return json.idToken;
}

export async function createUser(
  opts: { name?: string; email?: string; emailVerified?: boolean; uid?: string } = {},
): Promise<TestUser> {
  const id = uniq();
  const email = (
    opts.email ?? `${(opts.name ?? 'user').toLowerCase().replace(/[^a-z0-9]/g, '')}.${id}@test.dev`
  ).toLowerCase();
  const displayName = opts.name ?? `User ${id}`;
  const password = 'password-123';
  const rec = await auth().createUser({
    ...(opts.uid ? { uid: opts.uid } : {}),
    email,
    password,
    displayName,
    emailVerified: opts.emailVerified ?? true,
  });
  const token = await mintIdToken(email, password);
  return { uid: rec.uid, email, displayName, password, token };
}

/** Re-mint the user's ID token in place (e.g. after revokeRefreshTokens). */
export async function refreshToken(user: TestUser): Promise<TestUser> {
  user.token = await mintIdToken(user.email, user.password);
  return user;
}

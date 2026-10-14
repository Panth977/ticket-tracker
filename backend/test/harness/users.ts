/**
 * Test users: real accounts with real ID tokens, so the `user` middleware
 * runs exactly as in production — Auth-emulator accounts on Firebase, local
 * identity accounts (password sign-in) on a VM (TM_PLATFORM=vm).
 */
import { identity, identityKind, type UserRecord } from '../../src/identity/index.js';
import type { Ports } from '@tm/shared';
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

/** Sign in (Auth emulator REST API, or the local identity) and return the ID token. */
export async function mintIdToken(email: string, password: string): Promise<string> {
  if (identityKind() === 'local') {
    const { signInWithPassword } = await import('../../src/identity/local/flows.js');
    return (await asIfOutOfProcess(() => signInWithPassword(email, password))).idToken;
  }
  return mintEmulatorIdToken(email, password);
}

/**
 * On a VM the auth triggers (onUserCreated, beforeUserSignedIn) run in THIS
 * process; on Firebase they run in the functions emulator, out of the test's
 * way. Run them on the real clock and ids, so a test that pinned its own
 * sees the same sequence on both.
 */
let outOfProcess = 0;
let saved: Ports | undefined;
async function asIfOutOfProcess<T>(fn: () => Promise<T>): Promise<T> {
  const { setPorts, systemClock, randomIds } = await import('../../src/adapters/index.js');
  // Reference-counted: tests create people in parallel, and only the LAST one
  // out may put the test's own clock and ids back.
  if (outOfProcess++ === 0) saved = setPorts({ clock: systemClock(), ids: randomIds() });
  try {
    return await fn();
  } finally {
    if (--outOfProcess === 0 && saved) {
      setPorts(saved);
      saved = undefined;
    }
  }
}

/** Sign in against the Auth emulator's REST API (whatever TM_PLATFORM says). */
export async function mintEmulatorIdToken(email: string, password: string): Promise<string> {
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
  const props = {
    ...(opts.uid ? { uid: opts.uid } : {}),
    email,
    password,
    displayName,
    emailVerified: opts.emailVerified ?? true,
  };
  let rec: UserRecord;
  if (identityKind() === 'local') {
    // On a VM the auth trigger runs in THIS process: finish it here, before
    // the test pins its clock or ids (on Firebase it runs in the functions
    // emulator, out of the test's way).
    const { createAccount } = await import('../../src/identity/local/accounts.js');
    const { handleUserCreated } = await import('../../src/triggers/authUserCreated.js');
    rec = await createAccount(props);
    await asIfOutOfProcess(() => handleUserCreated(rec as never));
  } else {
    rec = await identity().createUser(props);
  }
  const token = await mintIdToken(email, password);
  return { uid: rec.uid, email, displayName, password, token };
}

/** Re-mint the user's ID token in place (e.g. after revokeRefreshTokens). */
export async function refreshToken(user: TestUser): Promise<TestUser> {
  user.token = await mintIdToken(user.email, user.password);
  return user;
}

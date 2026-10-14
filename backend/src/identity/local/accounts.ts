/**
 * Accounts of the local identity, in the database port (server-only '_'
 * collections — the rules deny every one of them to clients):
 *
 *   _authUsers/{uid}         the account (no secret but the password hash)
 *   _authEmails/{email}      { uid } — the address index; created in the same
 *                            transaction as the account, so an address is
 *                            never taken twice
 *   _authSessions/{sha256}   a refresh session (the token itself is never stored)
 *
 * The Identity methods (getUser, createUser, verifyIdToken …) behave like
 * Firebase Auth's, down to the error codes the callers test.
 */
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index.js';
import { sha256hex } from '../../platform/crypto.js';
import { getTrigger } from '../../runtime/functions.js';
import {
  IdentityError,
  type CreateRequest,
  type DecodedIdToken,
  type GetUsersResult,
  type Identity,
  type UpdateRequest,
  type UserIdentifier,
  type UserRecord,
} from '../types.js';
import { CUSTOM_TOKEN_TTL_S, hashPassword, ISSUER, signJwt, verifyJwt } from './tokens.js';

export const USERS = '_authUsers';
export const EMAILS = '_authEmails';
export const SESSIONS = '_authSessions';

export interface AccountDoc {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoURL: string | null;
  disabled: boolean;
  passwordHash: string | null;
  /** Sign-in methods used: 'password', 'emailLink', 'google.com', 'microsoft.com', 'custom'. */
  providers: string[];
  createdAt: number;
  lastSignInAt: number | null;
  /** Seconds: tokens issued before this are revoked. */
  tokensValidAfter: number;
  customClaims: Record<string, unknown> | null;
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

function uidNew(): string {
  // 28 chars, the shape of a Firebase uid.
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (const b of randomBytes(40)) if (b < 248 && out.length < 28) out += A[b % 62];
  return out.padEnd(28, 'A');
}

const iso = (ms: number) => new Date(ms).toUTCString();

export function toRecord(a: AccountDoc): UserRecord {
  return {
    uid: a.uid,
    ...(a.email ? { email: a.email } : {}),
    emailVerified: a.emailVerified,
    ...(a.displayName ? { displayName: a.displayName } : {}),
    ...(a.photoURL ? { photoURL: a.photoURL } : {}),
    disabled: a.disabled,
    metadata: {
      creationTime: iso(a.createdAt),
      lastSignInTime: a.lastSignInAt ? iso(a.lastSignInAt) : '',
    },
    providerData: a.providers
      .filter((p) => p !== 'custom')
      .map((providerId) => ({
        providerId: providerId === 'emailLink' ? 'password' : providerId,
        uid: a.email ?? a.uid,
        ...(a.email ? { email: a.email } : {}),
      })),
    tokensValidAfterTime: iso(a.tokensValidAfter * 1000),
    ...(a.customClaims ? { customClaims: a.customClaims } : {}),
  };
}

const notFound = (what: string) =>
  new IdentityError(
    'auth/user-not-found',
    `There is no user record corresponding to the provided identifier (${what}).`,
  );

export async function readAccount(uid: string): Promise<AccountDoc | undefined> {
  return (await db().collection(USERS).doc(uid).get()).data() as AccountDoc | undefined;
}

export async function accountByEmail(email: string): Promise<AccountDoc | undefined> {
  const idx = (await db().collection(EMAILS).doc(normalizeEmail(email)).get()).data() as
    { uid: string } | undefined;
  return idx ? readAccount(idx.uid) : undefined;
}

/** Issue an ID token for an account (the session layer calls it). */
export function mintIdToken(
  a: AccountDoc,
  provider: string,
  authTimeS: number,
  nowS = Math.floor(Date.now() / 1000),
): string {
  return signJwt('id', {
    iss: ISSUER,
    aud: ISSUER,
    sub: a.uid,
    uid: a.uid,
    ...(a.email ? { email: a.email, email_verified: a.emailVerified } : {}),
    ...(a.displayName ? { name: a.displayName } : {}),
    iat: nowS,
    exp: nowS + 3600,
    auth_time: authTimeS,
    firebase: { sign_in_provider: provider },
    ...(a.customClaims ?? {}),
  });
}

export const localIdentity: Identity = {
  async verifyIdToken(idToken, checkRevoked = false) {
    const p = verifyJwt('id', idToken);
    const uid = String(p.sub ?? '');
    if (!uid) throw new IdentityError('auth/argument-error', 'Token has no subject');
    if (checkRevoked) {
      const a = await readAccount(uid);
      if (!a)
        throw new IdentityError('auth/user-not-found', 'The user of this token no longer exists');
      if (a.disabled)
        throw new IdentityError('auth/user-disabled', 'The user account has been disabled');
      // Firebase's rule: a token whose SIGN-IN (auth_time) predates the revocation is revoked.
      if ((p.auth_time as number) < a.tokensValidAfter)
        throw new IdentityError('auth/id-token-revoked', 'The ID token has been revoked');
    }
    return { ...p, uid } as DecodedIdToken;
  },

  async getUser(uid) {
    const a = await readAccount(uid);
    if (!a) throw notFound(`uid ${uid}`);
    return toRecord(a);
  },

  async getUserByEmail(email) {
    const a = await accountByEmail(email);
    if (!a) throw notFound(`email ${email}`);
    return toRecord(a);
  },

  async getUsers(ids: UserIdentifier[]): Promise<GetUsersResult> {
    const users: UserRecord[] = [];
    const notFoundIds: UserIdentifier[] = [];
    for (const id of ids) {
      const a = 'uid' in id ? await readAccount(id.uid) : await accountByEmail(id.email);
      if (a) users.push(toRecord(a));
      else notFoundIds.push(id);
    }
    return { users, notFound: notFoundIds };
  },

  async createUser(req: CreateRequest) {
    const rec = await createAccount(req);
    // As Firebase Auth: an account made through the admin API fires onUserCreated, asynchronously.
    fireLater('onUserCreated', rec);
    return rec;
  },

  async updateUser(uid, req: UpdateRequest) {
    return updateAccount(uid, req);
  },

  async deleteUser(uid) {
    const rec = await deleteAccount(uid);
    fireLater('onUserDeleted', rec);
  },

  async revokeRefreshTokens(uid) {
    return revoke(uid);
  },

  async createCustomToken(uid, claims) {
    const now = Math.floor(Date.now() / 1000);
    return signJwt('custom', {
      iss: ISSUER,
      sub: uid,
      iat: now,
      exp: now + CUSTOM_TOKEN_TTL_S,
      claims: claims ?? {},
    });
  },
};

function fireLater(name: 'onUserCreated' | 'onUserDeleted', rec: UserRecord): void {
  const h = getTrigger(name);
  if (!h) return;
  setImmediate(() => {
    h(rec as never).catch((e: unknown) => console.error(`[identity] ${name} ${rec.uid} failed`, e));
  });
}

/** Create the account (no trigger: the sign-in flows run onUserCreated themselves, awaited). */
export async function createAccount(req: CreateRequest): Promise<UserRecord> {
  const uid = req.uid ?? uidNew();
  const email = req.email ? normalizeEmail(req.email) : null;
  const now = Date.now();
  const a: AccountDoc = {
    uid,
    email,
    emailVerified: req.emailVerified ?? false,
    displayName: req.displayName ?? null,
    photoURL: req.photoURL ?? null,
    disabled: req.disabled ?? false,
    passwordHash: req.password ? await hashPassword(req.password) : null,
    providers: req.password ? ['password'] : [],
    createdAt: now,
    lastSignInAt: null,
    tokensValidAfter: 0,
    customClaims: null,
  };
  await db().runTransaction(async (tx) => {
    const userRef = db().collection(USERS).doc(uid);
    const emailRef = email ? db().collection(EMAILS).doc(email) : null;
    const [u, e] = await tx.getAll(userRef, ...(emailRef ? [emailRef] : []));
    if (u!.exists)
      throw new IdentityError(
        'auth/uid-already-exists',
        'The user with the provided uid already exists.',
      );
    if (e?.exists)
      throw new IdentityError(
        'auth/email-already-exists',
        'The email address is already in use by another account.',
      );
    tx.create(userRef, a);
    if (emailRef) tx.create(emailRef, { uid });
  });
  return toRecord(a);
}

export async function updateAccount(uid: string, req: UpdateRequest): Promise<UserRecord> {
  const passwordHash = req.password ? await hashPassword(req.password) : undefined;
  const next = await db().runTransaction(async (tx) => {
    const ref = db().collection(USERS).doc(uid);
    const a = (await tx.get(ref)).data() as AccountDoc | undefined;
    if (!a) throw notFound(`uid ${uid}`);
    const email =
      req.email !== undefined ? (req.email ? normalizeEmail(req.email) : null) : a.email;
    if (email !== a.email && email) {
      const taken = await tx.get(db().collection(EMAILS).doc(email));
      if (taken.exists)
        throw new IdentityError(
          'auth/email-already-exists',
          'The email address is already in use by another account.',
        );
    }
    const updated: AccountDoc = {
      ...a,
      email,
      emailVerified: req.emailVerified ?? (email !== a.email ? false : a.emailVerified),
      ...(req.displayName !== undefined ? { displayName: req.displayName } : {}),
      ...(req.photoURL !== undefined ? { photoURL: req.photoURL } : {}),
      ...(req.disabled !== undefined ? { disabled: req.disabled } : {}),
      ...(passwordHash
        ? { passwordHash, providers: [...new Set([...a.providers, 'password'])] }
        : {}),
    };
    tx.set(ref, updated);
    if (email !== a.email) {
      if (a.email) tx.delete(db().collection(EMAILS).doc(a.email));
      if (email) tx.create(db().collection(EMAILS).doc(email), { uid });
    }
    return updated;
  });
  return toRecord(next);
}

export async function deleteAccount(uid: string): Promise<UserRecord> {
  const a = await readAccount(uid);
  if (!a) throw notFound(`uid ${uid}`);
  const batch = db().batch();
  batch.delete(db().collection(USERS).doc(uid));
  if (a.email) batch.delete(db().collection(EMAILS).doc(a.email));
  await batch.commit();
  const sessions = await db().collection(SESSIONS).where('uid', '==', uid).get();
  const b2 = db().batch();
  sessions.docs.forEach((d) => b2.delete(d.ref));
  if (!sessions.empty) await b2.commit();
  return toRecord(a);
}

async function revoke(uid: string): Promise<void> {
  const a = await readAccount(uid);
  if (!a) throw notFound(`uid ${uid}`);
  // Firebase's rule: tokens issued in an earlier SECOND than this are revoked.
  await db()
    .collection(USERS)
    .doc(uid)
    .update({ tokensValidAfter: Math.floor(Date.now() / 1000) });
  const sessions = await db().collection(SESSIONS).where('uid', '==', uid).get();
  const batch = db().batch();
  sessions.docs.forEach((d) => batch.delete(d.ref));
  if (!sessions.empty) await batch.commit();
}

export const sessionId = (refreshToken: string) => sha256hex(`refresh\n${refreshToken}`);

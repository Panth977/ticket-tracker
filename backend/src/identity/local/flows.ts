/**
 * SIGN-IN FLOWS of the local identity — what Firebase Auth's servers do for
 * the Firebase deploy, done here for a VM:
 *
 *   sessions       an ID token (1 h) + a refresh token (opaque, stored only
 *                  as a hash in _authSessions); refresh mints a new ID token
 *                  with the same auth_time, as Firebase does
 *   password       sign in, re-authenticate, change (needs a sign-in within
 *                  the last 5 minutes: auth/requires-recent-login)
 *   e-mail link    a one-hour, single-use link mailed through the email port;
 *                  signing in with it verifies the address (new account on
 *                  first use). Also "verify before changing the e-mail".
 *   OpenID Connect Google / Microsoft (authorization code + PKCE, then the
 *                  provider's userinfo over TLS); configured by
 *                  GOOGLE_CLIENT_ID/_SECRET, MS_CLIENT_ID/_SECRET (+MS_TENANT)
 *   custom token   exchanged once for a session (agents' live stream)
 *
 * The auth TRIGGERS run as on Firebase: a new account → onUserCreated; every
 * sign-in → beforeUserSignedIn (both are the handlers in src/triggers/).
 */
import { createHash } from 'node:crypto';
import { db } from '../../db/index.js';
import { ports } from '../../adapters/index.js';
import { appUrl } from '../../notify/config.js';
import { getTrigger } from '../../runtime/functions.js';
import { IdentityError, type UserRecord } from '../types.js';
import {
  accountByEmail,
  createAccount,
  localIdentity,
  mintIdToken,
  normalizeEmail,
  readAccount,
  sessionId,
  SESSIONS,
  toRecord,
  USERS,
  type AccountDoc,
} from './accounts.js';
import { checkPassword, hashPassword, ID_TOKEN_TTL_S, secret, verifyJwt } from './tokens.js';
import { appName } from '../../runtime/brand.js';

export const LINKS = '_authLinks';
export const OAUTH = '_authOauth';
export const PROVIDER_IDS = '_authProviders';
const LINK_TTL_MS = 3600_000;
const OAUTH_TTL_MS = 600_000;
const RECENT_LOGIN_S = 300;

export interface Session {
  idToken: string;
  refreshToken: string;
  expiresIn: number;
  user: UserRecord;
  /** The account's first sign-in (Firebase's getAdditionalUserInfo().isNewUser). */
  isNewUser: boolean;
}

const nowS = () => Math.floor(Date.now() / 1000);
const linkId = (token: string) => createHash('sha256').update(`link\n${token}`).digest('hex');

// ─── triggers ────────────────────────────────────────────────────────────────

async function afterCreate(a: AccountDoc): Promise<void> {
  const h = getTrigger('onUserCreated');
  if (h) await h(toRecord(a) as never);
}
async function beforeSignIn(a: AccountDoc): Promise<void> {
  const h = getTrigger('beforeUserSignedIn');
  if (h) await h({ data: toRecord(a) } as never);
}

// ─── sessions ────────────────────────────────────────────────────────────────

async function startSession(
  a: AccountDoc,
  provider: string,
  claims: Record<string, unknown> = {},
): Promise<Session> {
  if (a.disabled)
    throw new IdentityError('auth/user-disabled', 'The user account has been disabled');
  await beforeSignIn(a);
  const authTime = nowS();
  const refreshToken = secret();
  const now = Date.now();
  await db().collection(SESSIONS).doc(sessionId(refreshToken)).set({
    uid: a.uid,
    provider,
    authTime,
    claims,
    createdAt: now,
    lastUsedAt: now,
  });
  const providers = a.providers.includes(provider) ? a.providers : [...a.providers, provider];
  await db().collection(USERS).doc(a.uid).update({ lastSignInAt: now, providers });
  const fresh = { ...a, lastSignInAt: now, providers };
  return {
    idToken: mintIdToken(fresh, provider, authTime, undefined, claims),
    refreshToken,
    expiresIn: ID_TOKEN_TTL_S,
    user: toRecord(fresh),
    isNewUser: !a.lastSignInAt,
  };
}

export async function refreshSession(refreshToken: string): Promise<Session> {
  const ref = db().collection(SESSIONS).doc(sessionId(refreshToken));
  const s = (await ref.get()).data() as
    | { uid: string; provider: string; authTime: number; claims?: Record<string, unknown> }
    | undefined;
  if (!s)
    throw new IdentityError('auth/invalid-refresh-token', 'This session has ended — sign in again');
  const a = await readAccount(s.uid);
  if (!a || a.disabled || s.authTime < a.tokensValidAfter) {
    await ref.delete();
    throw new IdentityError('auth/invalid-refresh-token', 'This session has ended — sign in again');
  }
  await ref.update({ lastUsedAt: Date.now() });
  return {
    idToken: mintIdToken(a, s.provider, s.authTime, undefined, s.claims ?? {}),
    refreshToken,
    expiresIn: ID_TOKEN_TTL_S,
    user: toRecord(a),
    isNewUser: false,
  };
}

export async function endSession(refreshToken: string): Promise<void> {
  await db().collection(SESSIONS).doc(sessionId(refreshToken)).delete();
}

/** An account for this address: the existing one, or a new one (verified when the address was proven). */
async function accountFor(
  email: string,
  verified: boolean,
  profile: { displayName?: string | null; photoURL?: string | null } = {},
): Promise<AccountDoc> {
  const found = await accountByEmail(email);
  if (found) {
    if (verified && !found.emailVerified) {
      await db().collection(USERS).doc(found.uid).update({ emailVerified: true });
      return { ...found, emailVerified: true };
    }
    return found;
  }
  try {
    await createAccount({
      email,
      emailVerified: verified,
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
      ...(profile.photoURL ? { photoURL: profile.photoURL } : {}),
    });
  } catch (e) {
    // Two first sign-ins at once: the other one created it.
    if ((e as IdentityError).code !== 'auth/email-already-exists') throw e;
    return (await accountByEmail(email))!;
  }
  const a = (await accountByEmail(email))!;
  await afterCreate(a);
  return a;
}

// ─── password ────────────────────────────────────────────────────────────────

export async function signInWithPassword(email: string, password: string): Promise<Session> {
  const a = await accountByEmail(email);
  if (!a || !(await checkPassword(password, a.passwordHash)))
    throw new IdentityError('auth/invalid-credential', 'Wrong e-mail or password');
  return startSession(a, 'password');
}

/** Re-authenticate (the "confirm your password" step before a sensitive change). */
export async function reauthWithPassword(uid: string, password: string): Promise<Session> {
  const a = await readAccount(uid);
  if (!a || !(await checkPassword(password, a.passwordHash)))
    throw new IdentityError('auth/invalid-credential', 'Wrong password');
  return startSession(a, 'password');
}

export async function updatePassword(
  uid: string,
  authTimeS: number,
  newPassword: string,
): Promise<void> {
  if (nowS() - authTimeS > RECENT_LOGIN_S)
    throw new IdentityError(
      'auth/requires-recent-login',
      'Sign in again before changing your password',
    );
  if (newPassword.length < 6)
    throw new IdentityError('auth/weak-password', 'Password should be at least 6 characters');
  await db()
    .collection(USERS)
    .doc(uid)
    .update({ passwordHash: await hashPassword(newPassword) });
}

// ─── e-mail links ────────────────────────────────────────────────────────────

type LinkPurpose = 'signIn' | 'changeEmail';

/** The link a mail carries: the app's own page, with the one-time token. */
function linkUrl(continueUrl: string | undefined, token: string): string {
  const base = appUrl();
  let url: URL;
  try {
    url = new URL(continueUrl || `${base}/login`, base);
    // Never mail a link to somewhere else.
    if (url.origin !== new URL(base).origin) url = new URL(`${base}/login`);
  } catch {
    url = new URL(`${base}/login`);
  }
  url.searchParams.set('tm_link', token);
  return url.toString();
}

async function mailLink(
  email: string,
  purpose: LinkPurpose,
  continueUrl: string | undefined,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const token = secret();
  await db()
    .collection(LINKS)
    .doc(linkId(token))
    .set({ email: normalizeEmail(email), purpose, exp: Date.now() + LINK_TTL_MS, ...extra });
  const url = linkUrl(continueUrl, token);
  const signIn = purpose === 'signIn';
  await ports().email.send({
    to: normalizeEmail(email),
    subject: signIn ? `Sign in to ${appName()}` : 'Confirm your new e-mail address',
    text: signIn
      ? `Open this link to sign in (it works once, for one hour):\n\n${url}\n\nIf you did not ask for it, ignore this mail.`
      : `Open this link to make this your ${appName()} address (it works once, for one hour):\n\n${url}\n`,
    tag: signIn ? 'signin-link' : 'email-change',
  });
}

export const sendSignInLink = (email: string, continueUrl?: string) =>
  mailLink(email, 'signIn', continueUrl);

export async function sendEmailChangeLink(
  uid: string,
  newEmail: string,
  continueUrl?: string,
): Promise<void> {
  if (await accountByEmail(newEmail))
    throw new IdentityError(
      'auth/email-already-exists',
      'The email address is already in use by another account.',
    );
  await mailLink(newEmail, 'changeEmail', continueUrl, { uid });
}

/** Use a link (once). A sign-in link answers a session; a change link answers null. */
export async function useLink(token: string, email?: string): Promise<Session | null> {
  const ref = db().collection(LINKS).doc(linkId(token));
  const link = await db().runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data() as
      { email: string; purpose: LinkPurpose; exp: number; uid?: string } | undefined;
    if (d) tx.delete(ref);
    return d;
  });
  if (!link || link.exp < Date.now())
    throw new IdentityError(
      'auth/invalid-action-code',
      'This link has expired or was already used',
    );
  if (email && normalizeEmail(email) !== link.email)
    throw new IdentityError('auth/invalid-email', 'This link was sent to a different address');
  if (link.purpose === 'changeEmail') {
    await localIdentity.updateUser(link.uid!, { email: link.email, emailVerified: true });
    const a = await readAccount(link.uid!);
    if (a) await beforeSignIn(a); // the e-mail-change sync (triggers/authSignedIn.ts)
    return null;
  }
  return startSession(await accountFor(link.email, true), 'emailLink');
}

// ─── custom tokens ───────────────────────────────────────────────────────────

export async function signInWithCustomToken(token: string): Promise<Session> {
  const p = verifyJwt('custom', token);
  const uid = String(p.sub ?? '');
  let a = await readAccount(uid);
  if (!a) {
    await createAccount({ uid });
    a = (await readAccount(uid))!;
    await afterCreate(a);
  }
  // Developer claims belong to this session alone (as in Firebase), not the account.
  return startSession(a, 'custom', (p.claims ?? {}) as Record<string, unknown>);
}

// ─── OpenID Connect (Google, Microsoft) ──────────────────────────────────────

export type OidcProvider = 'google.com' | 'microsoft.com';

interface OidcConfig {
  clientId: string;
  clientSecret: string;
  discovery: string;
}

export function oidcConfig(
  provider: OidcProvider,
  env: NodeJS.ProcessEnv = process.env,
): OidcConfig | null {
  if (provider === 'google.com') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
    return {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      discovery: 'https://accounts.google.com/.well-known/openid-configuration',
    };
  }
  if (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) return null;
  return {
    clientId: env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
    discovery: `https://login.microsoftonline.com/${env.MS_TENANT || 'common'}/v2.0/.well-known/openid-configuration`,
  };
}

export const configuredProviders = (): OidcProvider[] =>
  (['google.com', 'microsoft.com'] as const).filter((p) => oidcConfig(p));

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}
const discoveries = new Map<string, Promise<Discovery>>();
function discover(url: string): Promise<Discovery> {
  let d = discoveries.get(url);
  if (!d) {
    d = fetch(url, { signal: AbortSignal.timeout(10_000) }).then(async (r) => {
      if (!r.ok) throw new Error(`OIDC discovery ${url}: ${r.status}`);
      return (await r.json()) as Discovery;
    });
    d.catch(() => discoveries.delete(url));
    discoveries.set(url, d);
  }
  return d;
}

/** Where to send the browser to sign in; `redirectUri` is our callback. */
export async function oidcStart(
  provider: OidcProvider,
  redirectUri: string,
  popup: boolean,
): Promise<string> {
  const cfg = oidcConfig(provider);
  if (!cfg)
    throw new IdentityError('auth/operation-not-allowed', `${provider} sign-in is not configured`);
  const d = await discover(cfg.discovery);
  const state = secret(24);
  const verifier = secret(48);
  await db()
    .collection(OAUTH)
    .doc(state)
    .set({ provider, verifier, redirectUri, popup, exp: Date.now() + OAUTH_TTL_MS });
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

/** The provider sent the browser back: trade the code for the person, then a session. */
export async function oidcFinish(
  provider: OidcProvider,
  code: string,
  state: string,
): Promise<{ session: Session; popup: boolean }> {
  const ref = db().collection(OAUTH).doc(state);
  const pending = await db().runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data() as
      | { provider: string; verifier: string; redirectUri: string; popup: boolean; exp: number }
      | undefined;
    if (d) tx.delete(ref);
    return d;
  });
  if (!pending || pending.provider !== provider || pending.exp < Date.now())
    throw new IdentityError('auth/invalid-credential', 'This sign-in has expired — try again');
  const cfg = oidcConfig(provider)!;
  const d = await discover(cfg.discovery);
  const tokenRes = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: pending.verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok)
    throw new IdentityError('auth/invalid-credential', `${provider} refused the sign-in`);
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  const infoRes = await fetch(d.userinfo_endpoint, {
    headers: { authorization: `Bearer ${access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!infoRes.ok)
    throw new IdentityError('auth/invalid-credential', `${provider} did not say who you are`);
  const info = (await infoRes.json()) as {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  // Microsoft's userinfo carries no email_verified; an organisation account's address is its sign-in.
  const verified = info.email_verified ?? provider === 'microsoft.com';
  const linkRef = db().collection(PROVIDER_IDS).doc(`${provider}:${info.sub}`);
  const linked = (await linkRef.get()).data() as { uid: string } | undefined;
  let a = linked ? await readAccount(linked.uid) : undefined;
  if (!a) {
    if (!info.email)
      throw new IdentityError('auth/invalid-credential', `${provider} shared no e-mail address`);
    // An unproven address must never open somebody else's account.
    if (!verified && (await accountByEmail(info.email)))
      throw new IdentityError(
        'auth/account-exists-with-different-credential',
        'An account with this e-mail exists — sign in with the e-mail link first',
      );
    a = await accountFor(info.email, verified, {
      displayName: info.name ?? null,
      photoURL: info.picture ?? null,
    });
    await linkRef.set({ uid: a.uid });
  }
  return { session: await startSession(a, provider), popup: pending.popup };
}

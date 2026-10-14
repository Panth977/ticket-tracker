/**
 * THE SIGN-IN DOOR of the local identity (TM_AUTH=local, a VM) — what
 * Firebase Auth's own endpoints are for the Firebase deploy:
 *
 *   GET  /identity/providers                     which sign-in methods are on
 *   POST /identity/password/signin {email,password}           → session
 *   POST /identity/link/send       {email, continueUrl?}      → 204 (mail sent)
 *   POST /identity/link/signin     {token, email?}            → session | 204
 *   POST /identity/token/refresh   {refreshToken}             → session
 *   POST /identity/token/custom    {token}                    → session
 *   POST /identity/signout         {refreshToken}             → 204
 *   POST /identity/password/reauth {password}       (Bearer)  → session
 *   POST /identity/password/update {newPassword}    (Bearer)  → 204
 *   POST /identity/email/change    {newEmail, continueUrl?} (Bearer) → 204
 *   GET  /identity/oauth/{google.com|microsoft.com}/start?popup=1
 *   GET  /identity/oauth/{provider}/callback       (the provider returns here)
 *
 * A session is { idToken, refreshToken, expiresIn, user } — the client keeps
 * the refresh token and sends the ID token as `Authorization: Bearer`,
 * exactly as with Firebase.
 *
 * On Firebase (TM_AUTH=firebase) every route answers 404.
 */
import type { Context } from 'hono';
import { errors } from '@tm/shared';
import type { AppEnv } from '../http/env.js';
import { door } from '../http/mounts.js';
import { bearer } from '../middleware/user.js';
import { appUrl } from '../notify/config.js';
import { identity, identityKind, IdentityError } from '../identity/index.js';
import {
  configuredProviders,
  endSession,
  oidcFinish,
  oidcStart,
  reauthWithPassword,
  refreshSession,
  sendEmailChangeLink,
  sendSignInLink,
  signInWithCustomToken,
  signInWithPassword,
  updatePassword,
  useLink,
  type OidcProvider,
} from '../identity/local/flows.js';

const id = door('identity');

/**
 * Our errors → the app's problem vocabulary (never echo token details). The
 * Firebase-style code rides along as `authCode`, so the VM build's auth shim
 * can throw exactly what the Firebase SDK would.
 */
function fail(e: unknown): never {
  if (!(e instanceof IdentityError)) throw e;
  const ext = { authCode: e.code };
  switch (e.code) {
    case 'auth/requires-recent-login':
      throw errors.forbidden(e.message, { ...ext, reason: 'requiresRecentLogin' });
    case 'auth/email-already-exists':
    case 'auth/account-exists-with-different-credential':
      throw errors.conflict(e.message, ext);
    case 'auth/weak-password':
    case 'auth/invalid-email':
      throw errors.invalid(e.message, ext);
    case 'auth/operation-not-allowed':
      throw errors.forbidden(e.message, ext);
    default:
      throw errors.unauthenticated(e.message, ext);
  }
}

async function body<T>(c: Context<AppEnv>): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.invalid('A JSON body is required');
  }
}
const str = (v: unknown, field: string, max = 2000): string => {
  if (typeof v !== 'string' || !v || v.length > max)
    throw errors.invalid(`${field} is required`, { field });
  return v;
};

async function caller(c: Context<AppEnv>): Promise<{ uid: string; authTime: number }> {
  const token = bearer(c.req.header('authorization'));
  if (!token) throw errors.unauthenticated('Missing bearer token');
  try {
    const d = await identity().verifyIdToken(token, true);
    return { uid: d.uid, authTime: d.auth_time };
  } catch (e) {
    return fail(e);
  }
}

// A small per-address brake on mailing links (a VM has no Identity Toolkit quota in front of it).
const sent = new Map<string, number[]>();
function brake(key: string, max = 5, windowMs = 3600_000): void {
  const now = Date.now();
  const hits = (sent.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max)
    throw errors.rate_limited('Too many links for this address — try again later');
  hits.push(now);
  sent.set(key, hits);
}

id.use('*', async (c, next) => {
  if (identityKind() !== 'local')
    throw errors.not_found(`No route for ${c.req.method} ${c.req.path}`);
  c.header('cache-control', 'no-store');
  await next();
});

id.get('/providers', (c) =>
  c.json({ password: true, emailLink: true, oidc: configuredProviders() }),
);

id.post('/password/signin', async (c) => {
  const b = await body<{ email?: unknown; password?: unknown }>(c);
  return c.json(
    await signInWithPassword(str(b.email, 'email', 320), str(b.password, 'password', 1024)).catch(
      fail,
    ),
  );
});

id.post('/link/send', async (c) => {
  const b = await body<{ email?: unknown; continueUrl?: unknown }>(c);
  const email = str(b.email, 'email', 320).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw errors.invalid('That is not an e-mail address', { field: 'email' });
  brake(email);
  await sendSignInLink(email, typeof b.continueUrl === 'string' ? b.continueUrl : undefined).catch(
    fail,
  );
  return c.body(null, 204);
});

id.post('/link/signin', async (c) => {
  const b = await body<{ token?: unknown; email?: unknown }>(c);
  const session = await useLink(
    str(b.token, 'token', 200),
    typeof b.email === 'string' ? b.email : undefined,
  ).catch(fail);
  return session ? c.json(session) : c.body(null, 204);
});

id.post('/token/refresh', async (c) => {
  const b = await body<{ refreshToken?: unknown }>(c);
  return c.json(await refreshSession(str(b.refreshToken, 'refreshToken', 200)).catch(fail));
});

id.post('/token/custom', async (c) => {
  const b = await body<{ token?: unknown }>(c);
  return c.json(await signInWithCustomToken(str(b.token, 'token', 4000)).catch(fail));
});

id.post('/signout', async (c) => {
  const b = await body<{ refreshToken?: unknown }>(c);
  if (typeof b.refreshToken === 'string' && b.refreshToken) await endSession(b.refreshToken);
  return c.body(null, 204);
});

id.post('/password/reauth', async (c) => {
  const { uid } = await caller(c);
  const b = await body<{ password?: unknown }>(c);
  return c.json(await reauthWithPassword(uid, str(b.password, 'password', 1024)).catch(fail));
});

id.post('/password/update', async (c) => {
  const { uid, authTime } = await caller(c);
  const b = await body<{ newPassword?: unknown }>(c);
  await updatePassword(uid, authTime, str(b.newPassword, 'newPassword', 1024)).catch(fail);
  return c.body(null, 204);
});

id.post('/email/change', async (c) => {
  const { uid } = await caller(c);
  const b = await body<{ newEmail?: unknown; continueUrl?: unknown }>(c);
  const email = str(b.newEmail, 'newEmail', 320).trim().toLowerCase();
  brake(email);
  await sendEmailChangeLink(
    uid,
    email,
    typeof b.continueUrl === 'string' ? b.continueUrl : undefined,
  ).catch(fail);
  return c.body(null, 204);
});

const isProvider = (p: string): p is OidcProvider => p === 'google.com' || p === 'microsoft.com';
const callbackUrl = (provider: string) => `${appUrl()}/identity/oauth/${provider}/callback`;

id.get('/oauth/:provider/start', async (c) => {
  const provider = c.req.param('provider');
  if (!isProvider(provider)) throw errors.not_found('Unknown sign-in provider');
  const url = await oidcStart(provider, callbackUrl(provider), c.req.query('popup') === '1').catch(
    fail,
  );
  return c.redirect(url, 302);
});

/**
 * The provider's redirect lands here. A popup hands the session to the page
 * that opened it (postMessage to the app's own origin only) and closes; a
 * full-page sign-in goes back to /login with the session in the fragment,
 * which never reaches a server log.
 */
id.get('/oauth/:provider/callback', async (c) => {
  const provider = c.req.param('provider');
  if (!isProvider(provider)) throw errors.not_found('Unknown sign-in provider');
  const origin = new URL(appUrl()).origin;
  let payload: unknown;
  let popup = true;
  try {
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state)
      throw new IdentityError(
        'auth/invalid-credential',
        c.req.query('error_description') || 'Sign-in was cancelled',
      );
    const r = await oidcFinish(provider, code, state);
    payload = { type: 'tm-identity', session: r.session };
    popup = r.popup;
  } catch (e) {
    payload = {
      type: 'tm-identity',
      error: e instanceof IdentityError ? e.message : 'Sign-in failed',
    };
  }
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const script = popup
    ? `window.opener&&window.opener.postMessage(${json},${JSON.stringify(origin)});window.close();`
    : `location.replace(${JSON.stringify(`${origin}/login`)}+'#tm_identity='+encodeURIComponent(JSON.stringify(${json})));`;
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Signing in…</title><p>Signing in…</p><script>${script}</script>`,
    200,
    { 'referrer-policy': 'no-referrer' },
  );
});

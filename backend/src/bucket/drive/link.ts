/**
 * A PERSON'S GOOGLE DRIVE CONNECTION (docs/plan/bucket.html §K1).
 *
 * Signing in with Google gives the BROWSER an access token for an hour; the
 * server never sees it and could not use it at 3 a.m. when an agent attaches a
 * file. So connecting Drive is its own step: Google's consent page with
 * access_type=offline and scope drive.file → /integrations/drive/callback
 * exchanges the code for a REFRESH token, kept here:
 *
 *   _driveLinks/{uid}   { email, refresh (AES-256-GCM, key derived from the
 *                         server's signing key), scope, connectedAt, brokenAt }
 *
 * Rules deny every '_' collection: only the Admin SDK reads it, and nothing
 * returns the refresh token to anyone. Access tokens live in memory (an hour).
 *
 * CONFIGURATION. TM_GOOGLE_CLIENT_ID + TM_GOOGLE_CLIENT_SECRET (a Web OAuth
 * client; redirect URI {API_URL}/integrations/drive/callback). The picker
 * also needs TM_GOOGLE_API_KEY and TM_GOOGLE_APP_ID (the project number).
 * With no client under the emulators (or TM_DRIVE=fake) every connection is
 * an in-memory fake Drive (api.ts) — the whole flow still runs.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DRIVE_SCOPE, errors, type DriveStatus } from '@tm/shared';
import { db, isEmulated } from '../../runtime/firebase.js';
import { base62, safeEqual, serverMac, signingKey } from '../../platform/crypto.js';
import { DriveAuthError, fakeDrive, httpDrive, type DriveApi } from './api.js';

export const DRIVE_LINKS = '_driveLinks';
const linkRef = (uid: string) => db().collection(DRIVE_LINKS).doc(uid);

/**
 * The connection, read at most once a minute per instance: a Drive bucket's
 * reads and writes should cost Firestore nothing beyond the bucket document.
 * Connect / disconnect / a broken refresh drop it here at once; another
 * instance notices within LINK_TTL_MS (and Google refuses a revoked token anyway).
 */
const LINK_TTL_MS = 60_000;
const links = new Map<string, { link: DriveLink | undefined; at: number }>();
async function readLink(uid: string): Promise<DriveLink | undefined> {
  const hit = links.get(uid);
  if (hit && Date.now() - hit.at < LINK_TTL_MS) return hit.link;
  const link = (await linkRef(uid).get()).data() as DriveLink | undefined;
  links.set(uid, { link, at: Date.now() });
  return link;
}
const forgetLink = (uid: string) => links.delete(uid);

interface DriveLink {
  email: string | null;
  /** v1.{iv}.{tag}.{ciphertext}, base64url. */
  refresh: string;
  scope: string;
  fake: boolean;
  connectedAt: number;
  updatedAt: number;
  /** Set when Google refused the refresh token (revoked, expired): reconnect. */
  brokenAt: number | null;
}

// ─── configuration ───────────────────────────────────────────────────────────

const clientId = () => process.env.TM_GOOGLE_CLIENT_ID?.trim() || '';
const clientSecret = () => process.env.TM_GOOGLE_CLIENT_SECRET?.trim() || '';

/** Real Google, or the in-memory fake (emulators / tests / TM_DRIVE=fake). */
export function driveMode(): 'google' | 'fake' | 'off' {
  const forced = process.env.TM_DRIVE?.toLowerCase();
  if (forced === 'fake') return 'fake';
  if (forced === 'off') return 'off';
  if (clientId() && clientSecret()) return 'google';
  return isEmulated() ? 'fake' : 'off';
}

const pickerConfig = () => ({
  apiKey: process.env.TM_GOOGLE_API_KEY?.trim() || '',
  appId: process.env.TM_GOOGLE_APP_ID?.trim() || '',
});

export const NOT_CONFIGURED =
  'Google Drive is not set up on this server (TM_GOOGLE_CLIENT_ID / TM_GOOGLE_CLIENT_SECRET)';
export const NOT_CONNECTED = 'Connect your Google Drive first (Account › Google Drive)';
export const RECONNECT =
  'Google Drive is disconnected — its owner must reconnect it (Account › Google Drive)';

// ─── the refresh token, sealed ───────────────────────────────────────────────

const sealKey = () => createHash('sha256').update(`drive-refresh\n${signingKey()}`).digest();

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', sealKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct]
    .map((x) => (typeof x === 'string' ? x : x.toString('base64url')))
    .join('.');
}

export function unseal(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Not a sealed value');
  const d = createDecipheriv('aes-256-gcm', sealKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

// ─── OAuth: the consent URL, the state, the exchange ─────────────────────────

const STATE_TTL_MS = 10 * 60_000;
interface State {
  uid: string;
  returnTo: string;
  nonce: string;
  exp: number;
}

export function signDriveState(s: State): string {
  const body = Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${body}.${serverMac('drive-state', body)}`;
}

export function verifyDriveState(raw: string | undefined, now: number): State {
  const [body, mac] = (raw ?? '').split('.');
  if (!body || !mac || !safeEqual(mac, serverMac('drive-state', body)))
    throw errors.forbidden('Invalid Drive connect state');
  const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as State;
  if (s.exp < now) throw errors.forbidden('This Drive link expired — connect again');
  return s;
}

/**
 * Where Google sends the person back — registered in the OAuth client exactly
 * so: {API_URL}/integrations/drive/callback (APP_URL when the API shares the
 * app's origin, as on Hosting). The fake answers on the app's own origin.
 */
export function driveCallbackUrl(): string {
  if (driveMode() === 'fake') return '/integrations/drive/callback';
  const base = (process.env.API_URL || process.env.APP_URL || '').replace(/\/$/, '');
  if (!base) throw errors.unavailable('Google Drive needs API_URL (or APP_URL) for its callback');
  return `${base}/integrations/drive/callback`;
}

/** Where the person goes to say yes (or, faked, straight to our callback). */
export function driveConsentUrl(
  uid: string,
  returnTo: string,
  now: number,
  loginHint?: string | null,
): string {
  const mode = driveMode();
  if (mode === 'off') throw errors.unavailable(NOT_CONFIGURED);
  const state = signDriveState({ uid, returnTo, nonce: base62(12), exp: now + STATE_TTL_MS });
  const cb = driveCallbackUrl();
  if (mode === 'fake') return `${cb}?state=${encodeURIComponent(state)}&code=fake_${base62(12)}`;
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId());
  u.searchParams.set('redirect_uri', cb);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', `openid email ${DRIVE_SCOPE}`);
  u.searchParams.set('access_type', 'offline');
  // Always ask: Google only returns a refresh token on a consent it showed.
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  if (loginHint) u.searchParams.set('login_hint', loginHint);
  return u.toString();
}

interface TokenRes {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenCall(params: Record<string, string>): Promise<TokenRes> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...params }),
  });
  return (await res.json().catch(() => ({ error: `http_${res.status}` }))) as TokenRes;
}

/** The email in Google's id_token (it came straight from Google over TLS; not re-verified). */
function emailOf(idToken: string | undefined): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(idToken!.split('.')[1]!, 'base64url').toString('utf8'),
    ) as {
      email?: string;
    };
    return payload.email ?? null;
  } catch {
    return null;
  }
}

/** The callback: code → refresh token → _driveLinks/{uid}. */
export async function completeDriveConnect(uid: string, code: string, now: number): Promise<void> {
  const mode = driveMode();
  if (mode === 'off') throw errors.unavailable(NOT_CONFIGURED);
  let link: DriveLink;
  if (mode === 'fake') {
    link = {
      email: `${uid.slice(0, 8).toLowerCase()}@drive.test`,
      refresh: seal(`fake:${code}`),
      scope: DRIVE_SCOPE,
      fake: true,
      connectedAt: now,
      updatedAt: now,
      brokenAt: null,
    };
  } else {
    const t = await tokenCall({
      grant_type: 'authorization_code',
      code,
      redirect_uri: driveCallbackUrl(),
    });
    if (!t.refresh_token)
      throw errors.forbidden(
        `Google did not hand over Drive access (${t.error_description ?? t.error ?? 'no refresh token'})`,
      );
    if (!(t.scope ?? '').split(' ').includes(DRIVE_SCOPE))
      throw errors.forbidden(
        'Tick “See, edit, create and delete only the specific Google Drive files you use with this app” to connect Drive',
      );
    link = {
      email: emailOf(t.id_token),
      refresh: seal(t.refresh_token),
      scope: t.scope ?? DRIVE_SCOPE,
      fake: false,
      connectedAt: now,
      updatedAt: now,
      brokenAt: null,
    };
    if (t.access_token)
      tokens.set(uid, { token: t.access_token, exp: now + (t.expires_in ?? 3600) * 1000 - 60_000 });
  }
  await linkRef(uid).set(link);
  forgetLink(uid);
}

/** Forget a connection (and revoke it at Google, best effort). */
export async function disconnectDrive(uid: string): Promise<void> {
  const snap = await linkRef(uid).get();
  const link = snap.data() as DriveLink | undefined;
  tokens.delete(uid);
  if (!link) return;
  if (!link.fake)
    await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(unseal(link.refresh))}`,
      {
        method: 'POST',
      },
    ).catch(() => {});
  await linkRef(uid).delete();
  forgetLink(uid);
}

export async function driveStatusOf(uid: string): Promise<DriveStatus> {
  const mode = driveMode();
  const link =
    mode === 'off' ? undefined : ((await linkRef(uid).get()).data() as DriveLink | undefined);
  const p = pickerConfig();
  return {
    available: mode !== 'off',
    connected: !!link && !link.brokenAt,
    email: link?.email ?? null,
    connectedAt: link?.connectedAt ?? null,
    picker: mode === 'google' && !!p.apiKey && !!p.appId,
  };
}

/** The account's address, for bucket.storage.email. */
export async function driveEmail(uid: string): Promise<string | null> {
  return (await readLink(uid))?.email ?? null;
}

// ─── access tokens and the client ────────────────────────────────────────────

const tokens = new Map<string, { token: string; exp: number }>();

async function accessToken(uid: string): Promise<string> {
  const hit = tokens.get(uid);
  if (hit && hit.exp > Date.now()) return hit.token;
  const link = await readLink(uid);
  if (!link) throw errors.conflict(RECONNECT, { reason: 'drive_disconnected' });
  if (link.brokenAt) throw errors.conflict(RECONNECT, { reason: 'drive_disconnected' });
  const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: unseal(link.refresh) });
  if (!t.access_token) {
    if (t.error === 'invalid_grant') {
      await linkRef(uid).update({ brokenAt: Date.now(), updatedAt: Date.now() });
      forgetLink(uid);
      throw errors.conflict(RECONNECT, { reason: 'drive_disconnected' });
    }
    throw errors.unavailable(
      `Google did not renew Drive access (${t.error ?? 'unknown'}) — try again`,
    );
  }
  tokens.set(uid, {
    token: t.access_token,
    exp: Date.now() + (t.expires_in ?? 3600) * 1000 - 60_000,
  });
  return t.access_token;
}

/** For the picker: the browser of the Drive's own person gets a short-lived token. */
export async function pickerToken(uid: string): Promise<{
  accessToken: string;
  apiKey: string;
  appId: string;
  expiresAt: number;
}> {
  if (driveMode() !== 'google')
    throw errors.unavailable('The Google folder picker is not set up on this server');
  const p = pickerConfig();
  if (!p.apiKey || !p.appId)
    throw errors.unavailable(
      'The Google folder picker needs TM_GOOGLE_API_KEY and TM_GOOGLE_APP_ID',
    );
  const token = await accessToken(uid);
  return { accessToken: token, ...p, expiresAt: tokens.get(uid)?.exp ?? Date.now() + 30 * 60_000 };
}

/**
 * The Drive of person `uid` — every Drive bucket they made talks through this.
 * Throws a 409 ('drive_disconnected') when there is no usable connection; a
 * 401 from Drive mid-way marks the connection broken.
 */
export async function driveFor(uid: string): Promise<DriveApi> {
  const mode = driveMode();
  if (mode === 'off') throw errors.unavailable(NOT_CONFIGURED);
  const link = await readLink(uid);
  if (!link || link.brokenAt) throw errors.conflict(RECONNECT, { reason: 'drive_disconnected' });
  if (link.fake) return fakeDrive(uid);
  const api = httpDrive(() => accessToken(uid));
  // A 401 means the token we hold is dead: drop it, so the next call refreshes.
  return new Proxy(api, {
    get(target, prop: keyof DriveApi) {
      const fn = target[prop];
      return async (...args: unknown[]) => {
        try {
          return await (fn as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } catch (e) {
          if (e instanceof DriveAuthError) {
            tokens.delete(uid);
            throw errors.conflict(RECONNECT, { reason: 'drive_disconnected' });
          }
          throw e;
        }
      };
    },
  });
}

/**
 * `firebase/auth` FOR THE VM BUILD — the sign-in calls the app makes, against
 * the server's own identity (backend doors/identity.ts, TM_AUTH=local).
 *
 * A session is { idToken, refreshToken, user } exactly as Firebase keeps it:
 * the refresh token and the user live in localStorage (this device stays
 * signed in), the ID token in memory, refreshed before it expires. Every
 * change of token is handed to the /live socket (live.ts), and other tabs
 * follow a sign-in or sign-out through the storage event.
 *
 * Popups (Google, Microsoft) open /identity/oauth/{provider}/start?popup=1;
 * the callback page posts the session back to this origin and closes. Email
 * links carry ?tm_link=<token> back to the app's own /login.
 */
import { holdLiveUntil, LiveError, setLiveToken } from './live';

// ─── types the app reads ─────────────────────────────────────────────────────

interface UserInfo {
  providerId: string;
  uid?: string;
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
}
interface ServerUser {
  uid: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
  photoURL?: string;
  metadata: { creationTime?: string; lastSignInTime?: string };
  providerData: UserInfo[];
}
interface ServerSession {
  idToken: string;
  refreshToken: string;
  expiresIn: number;
  user: ServerUser;
  isNewUser?: boolean;
}

export class AuthError extends LiveError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

export interface UserCredential {
  user: User;
  providerId: string | null;
  operationType: 'signIn' | 'reauthenticate';
  _isNewUser: boolean;
}

export class User {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoURL: string | null;
  isAnonymous = false;
  metadata: { creationTime?: string; lastSignInTime?: string };
  providerData: UserInfo[];
  readonly providerId = 'firebase';

  constructor(u: ServerUser) {
    this.uid = u.uid;
    this.email = u.email ?? null;
    this.emailVerified = u.emailVerified;
    this.displayName = u.displayName ?? null;
    this.photoURL = u.photoURL ?? null;
    this.metadata = { ...u.metadata };
    this.providerData = (u.providerData ?? []).map((p) => ({ ...p }));
  }

  getIdToken(forceRefresh = false): Promise<string> {
    return freshToken(forceRefresh);
  }
  async getIdTokenResult(forceRefresh = false) {
    const token = await freshToken(forceRefresh);
    const claims = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    return { token, claims, authTime: new Date(Number(claims.auth_time) * 1000).toUTCString() };
  }
  /** Pick up server-side changes (a new password, a confirmed address). */
  async reload(): Promise<void> {
    await freshToken(true);
  }
  toJSON() {
    return { uid: this.uid, email: this.email, emailVerified: this.emailVerified, displayName: this.displayName, photoURL: this.photoURL };
  }
}

// ─── the session ─────────────────────────────────────────────────────────────

const KEY = 'tm.vm.session';

let idToken: string | null = null;
let expiresAt = 0;
let refreshToken: string | null = null;
let refreshing: Promise<string> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(u: User | null) => void>();
let restored = false;
let restoring: Promise<void> | null = null;

class Auth {
  currentUser: User | null = null;
  readonly name = '[DEFAULT]';
  languageCode: string | null = null;
  readonly config = {};
  authStateReady(): Promise<void> {
    return restore();
  }
  onAuthStateChanged(next: (u: User | null) => void): () => void {
    return onAuthStateChanged(this, next);
  }
  signOut(): Promise<void> {
    return signOut(this);
  }
}
const AUTH = new Auth();

function store(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function emit(): void {
  for (const l of [...listeners]) l(AUTH.currentUser);
}

function adopt(s: ServerSession): User {
  idToken = s.idToken;
  expiresAt = Date.now() + s.expiresIn * 1000;
  refreshToken = s.refreshToken;
  const before = AUTH.currentUser?.uid;
  AUTH.currentUser = new User(s.user);
  // The ID token too (as Firebase keeps it): a reload within the hour needs
  // no round trip before the app can talk to the server.
  store()?.setItem(KEY, JSON.stringify({ refreshToken, user: s.user, idToken, expiresAt }));
  setLiveToken(idToken);
  schedule();
  if (before !== AUTH.currentUser.uid) emit();
  return AUTH.currentUser;
}

function drop(): void {
  const had = !!AUTH.currentUser;
  idToken = null;
  refreshToken = null;
  expiresAt = 0;
  clearTimeout(timer);
  AUTH.currentUser = null;
  store()?.removeItem(KEY);
  setLiveToken(null);
  if (had) emit();
}

/** Refresh five minutes before expiry, so the socket and API calls never hold a stale token. */
function schedule(): void {
  clearTimeout(timer);
  const wait = Math.max(10_000, expiresAt - Date.now() - 5 * 60_000);
  timer = setTimeout(() => void freshToken(true).catch(() => {}), wait);
}

async function call<T>(path: string, body: unknown, bearer?: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`/identity${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError('auth/network-request-failed', 'A network error has occurred.');
  }
  if (res.status === 204) return null;
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code =
      typeof json.authCode === 'string'
        ? json.authCode
        : res.status === 429
          ? 'auth/too-many-requests'
          : res.status === 401
            ? 'auth/invalid-credential'
            : 'auth/internal-error';
    throw new AuthError(code, String(json.detail ?? json.title ?? 'Sign-in failed'));
  }
  return json as T;
}

async function freshToken(force: boolean): Promise<string> {
  await restore();
  return tokenNow(force);
}

/** The ID token, refreshed when needed — without waiting for restore() (which calls this). */
function tokenNow(force: boolean): Promise<string> {
  if (!refreshToken) return Promise.reject(new AuthError('auth/no-current-user', 'No user is signed in.'));
  if (!force && idToken && Date.now() < expiresAt - 60_000) return Promise.resolve(idToken);
  refreshing ??= (async () => {
    try {
      const s = await call<ServerSession>('/token/refresh', { refreshToken });
      adopt(s!);
      return idToken!;
    } catch (e) {
      // The session ended on the server (signed out everywhere, disabled): sign out here too.
      if ((e as AuthError).code !== 'auth/network-request-failed') drop();
      throw e;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** At boot: the device's session, then a full-page OAuth return (#tm_identity=…). */
function restore(): Promise<void> {
  if (restored) return Promise.resolve();
  restoring ??= (async () => {
    const fromPage = takeFragmentSession();
    if (fromPage) adopt(fromPage);
    else {
      let saved: { refreshToken: string; user: ServerUser; idToken?: string; expiresAt?: number } | null = null;
      try {
        const raw = store()?.getItem(KEY);
        saved = raw ? JSON.parse(raw) : null;
      } catch {
        saved = null;
      }
      if (saved?.refreshToken && saved.user) {
        refreshToken = saved.refreshToken;
        AUTH.currentUser = new User(saved.user);
        if (saved.idToken && (saved.expiresAt ?? 0) > Date.now() + 5 * 60_000) {
          // Still good: use it now, refresh in the background before it lapses.
          idToken = saved.idToken;
          expiresAt = saved.expiresAt!;
          setLiveToken(idToken);
          schedule();
        } else {
          await tokenNow(true).catch((e: AuthError) => {
            // Offline: keep the user (the app runs from what it has); else signed out.
            if (e.code !== 'auth/network-request-failed') drop();
          });
        }
      }
    }
    restored = true;
  })();
  return restoring;
}

function takeFragmentSession(): ServerSession | null {
  if (typeof location === 'undefined' || !location.hash.startsWith('#tm_identity=')) return null;
  try {
    const p = JSON.parse(decodeURIComponent(location.hash.slice('#tm_identity='.length))) as { session?: ServerSession };
    history.replaceState(null, '', location.pathname + location.search);
    return p.session ?? null;
  } catch {
    return null;
  }
}

if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    // Another tab signed in or out.
    if (!e.newValue) drop();
    else if (!AUTH.currentUser) {
      restored = false;
      restoring = null;
      void restore().then(emit);
    }
  });

if (typeof window !== 'undefined') holdLiveUntil(restore());

// ─── the API ─────────────────────────────────────────────────────────────────

export const getAuth = (..._a: unknown[]) => AUTH;
export const initializeAuth = getAuth;
export const connectAuthEmulator = (..._a: unknown[]) => {};
export const browserLocalPersistence = {};
export const setPersistence = async (..._a: unknown[]) => {};

export function onAuthStateChanged(_auth: Auth, next: ((u: User | null) => void) | { next?: (u: User | null) => void }): () => void {
  const fn = typeof next === 'function' ? next : (u: User | null) => next.next?.(u);
  listeners.add(fn);
  void restore().then(() => {
    if (listeners.has(fn)) fn(AUTH.currentUser);
  });
  return () => listeners.delete(fn);
}
export const onIdTokenChanged = onAuthStateChanged;

export class GoogleAuthProvider {
  static readonly PROVIDER_ID = 'google.com';
  readonly providerId = 'google.com';
  setCustomParameters(_p: Record<string, string>): this {
    return this;
  }
  addScope(_s: string): this {
    return this;
  }
}
export class OAuthProvider {
  constructor(readonly providerId: string) {}
  setCustomParameters(_p: Record<string, string>): this {
    return this;
  }
  addScope(_s: string): this {
    return this;
  }
}
export class EmailAuthProvider {
  static readonly PROVIDER_ID = 'password';
  static credential(email: string, password: string) {
    return { providerId: 'password', email, password };
  }
}

const credential = (user: User, s: ServerSession | null, op: UserCredential['operationType']): UserCredential => ({
  user,
  providerId: s?.user.providerData?.[0]?.providerId ?? null,
  operationType: op,
  _isNewUser: !!s?.isNewUser,
});

export const getAdditionalUserInfo = (cred: UserCredential) => ({ isNewUser: cred._isNewUser, providerId: cred.providerId, profile: null });

function popup(providerId: string): Promise<ServerSession> {
  const w = window.open(`/identity/oauth/${encodeURIComponent(providerId)}/start?popup=1`, 'tm-signin', 'width=500,height=650');
  if (!w) return Promise.reject(new AuthError('auth/popup-blocked', 'The sign-in popup was blocked.'));
  return new Promise((resolve, reject) => {
    const done = () => {
      window.removeEventListener('message', onMessage);
      clearInterval(poll);
    };
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; session?: ServerSession; error?: string };
      if (e.origin !== location.origin || d?.type !== 'tm-identity') return;
      done();
      if (d.session) resolve(d.session);
      else reject(new AuthError('auth/invalid-credential', d.error ?? 'Sign-in failed'));
    };
    window.addEventListener('message', onMessage);
    const poll = setInterval(() => {
      if (w.closed) {
        done();
        reject(new AuthError('auth/popup-closed-by-user', 'The popup was closed before sign-in finished.'));
      }
    }, 500);
  });
}

export async function signInWithPopup(_auth: Auth, provider: { providerId: string }): Promise<UserCredential> {
  const s = await popup(provider.providerId);
  return credential(adopt(s), s, 'signIn');
}
export const signInWithRedirect = async (_auth: Auth, provider: { providerId: string }) => {
  location.assign(`/identity/oauth/${encodeURIComponent(provider.providerId)}/start`);
};

export async function signInWithEmailAndPassword(_auth: Auth, email: string, password: string): Promise<UserCredential> {
  const s = (await call<ServerSession>('/password/signin', { email, password }))!;
  return credential(adopt(s), s, 'signIn');
}

export async function sendSignInLinkToEmail(_auth: Auth, email: string, settings: { url: string }): Promise<void> {
  await call('/link/send', { email, continueUrl: settings?.url });
}

export function isSignInWithEmailLink(_auth: Auth, href: string): boolean {
  try {
    return !!new URL(href).searchParams.get('tm_link');
  } catch {
    return false;
  }
}

export async function signInWithEmailLink(_auth: Auth, email: string, href = location.href): Promise<UserCredential> {
  const token = new URL(href).searchParams.get('tm_link');
  if (!token) throw new AuthError('auth/argument-error', 'Not a sign-in link');
  const s = await call<ServerSession>('/link/signin', { token, email });
  if (s) return credential(adopt(s), s, 'signIn');
  // An address-change link: the account changed, the session did not.
  if (!AUTH.currentUser) throw new AuthError('auth/invalid-action-code', 'Sign in to finish changing your address');
  await freshToken(true);
  return credential(AUTH.currentUser, null, 'signIn');
}

export async function signInWithCustomToken(_auth: Auth, token: string): Promise<UserCredential> {
  const s = (await call<ServerSession>('/token/custom', { token }))!;
  return credential(adopt(s), s, 'signIn');
}

export async function signOut(_auth?: Auth): Promise<void> {
  const rt = refreshToken;
  drop();
  if (rt) await call('/signout', { refreshToken: rt }).catch(() => {});
}

export async function reauthenticateWithCredential(user: User, cred: { password: string }): Promise<UserCredential> {
  const s = (await call<ServerSession>('/password/reauth', { password: cred.password }, await user.getIdToken()))!;
  return credential(adopt(s), s, 'reauthenticate');
}

export async function reauthenticateWithPopup(user: User, provider: { providerId: string }): Promise<UserCredential> {
  const s = await popup(provider.providerId);
  if (s.user.uid !== user.uid) throw new AuthError('auth/user-mismatch', 'That is a different account.');
  return credential(adopt(s), s, 'reauthenticate');
}

export async function updatePassword(user: User, newPassword: string): Promise<void> {
  await call('/password/update', { newPassword }, await user.getIdToken());
}

export async function verifyBeforeUpdateEmail(user: User, newEmail: string, settings?: { url?: string } | null): Promise<void> {
  await call('/email/change', { newEmail, continueUrl: settings?.url }, await user.getIdToken());
}

/** For the other shims: the signed-in user's ID token, or null. */
export async function currentIdToken(): Promise<string | null> {
  await restore();
  return refreshToken ? freshToken(false).catch(() => null) : null;
}

export type { Auth };

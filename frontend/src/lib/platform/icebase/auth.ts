/**
 * `firebase/auth` FOR THE EMULATOR BUILD (TM_ICEBASE=emulator) — Firebase's own SDK, talking to the
 * IceBase server this page came from (it speaks Firebase Auth's API and signs its tokens). The
 * signed-in user's ID token is what IceBase's Firestore and Realtime Database compat send.
 */
import { configureIceBase, refreshIceBaseAuth } from '@panth977/icebase/compat/firestore';
import * as real from 'tm-real-auth';
import type { Auth, AuthProvider, User, UserCredential } from 'tm-real-auth';

export * from 'tm-real-auth';

const wired = new WeakSet<Auth>();

/** Firebase's Auth, pointed at this origin (once), its token handed to IceBase's compat. */
export function getAuth(app?: Parameters<typeof real.getAuth>[0]): Auth {
  const auth = real.getAuth(app);
  if (!wired.has(auth)) {
    wired.add(auth);
    real.connectAuthEmulator(auth, location.origin, { disableWarnings: true });
    // As Firebase's Firestore does: the first read waits until Auth has restored the signed-in
    // user (after a reload), so it is not sent as signed out and refused.
    configureIceBase({
      origin: location.origin,
      // The path a proxy in front of a VM deploy already upgrades (backend/icebase.config.ts).
      socketPath: '/live',
      idToken: async () => {
        await auth.authStateReady();
        return (await auth.currentUser?.getIdToken()) ?? null;
      },
    });
    real.onIdTokenChanged(auth, () => refreshIceBaseAuth());
  }
  return auth;
}
export const initializeAuth = (app: Parameters<typeof real.getAuth>[0]) => getAuth(app);
/** Already pointed at this origin by getAuth(). */
export const connectAuthEmulator = (..._a: unknown[]): void => {};

/** Google sign-in on this server: its own OAuth client (config.auth.custom.google). The popup ends
 * on the server's callback page, which posts a custom token back to this window. Microsoft is not
 * offered here. */
const googlePopup = (auth: Auth): Promise<UserCredential> => {
  const start = `${location.origin}/__/icebase/auth/google/start?mode=popup&return=${encodeURIComponent(location.href)}`;
  const popup = window.open(start, 'icebase-google', 'width=500,height=650');
  if (!popup) return Promise.reject(Object.assign(new Error('The sign-in popup was blocked'), { code: 'auth/popup-blocked', name: 'FirebaseError' }));
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (!popup.closed) return;
      cleanup();
      reject(Object.assign(new Error('The sign-in popup was closed'), { code: 'auth/popup-closed-by-user', name: 'FirebaseError' }));
    }, 800);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || (e.data as { icebase?: string })?.icebase !== 'google') return;
      cleanup();
      const d = e.data as { token?: string; error?: { code: string; message: string } };
      if (d.token) real.signInWithCustomToken(auth, d.token).then(resolve, reject);
      else reject(Object.assign(new Error(d.error?.message ?? 'Google sign-in failed'), { code: d.error?.code ?? 'auth/internal-error', name: 'FirebaseError' }));
    };
    const cleanup = () => {
      clearInterval(timer);
      window.removeEventListener('message', onMessage);
    };
    window.addEventListener('message', onMessage);
  });
};
const noPopup = (provider: AuthProvider): never => {
  throw Object.assign(new Error(`${provider.providerId} sign-in is not available on this server; use the e-mail link`), { code: 'auth/operation-not-allowed', name: 'FirebaseError' });
};
export const signInWithPopup = async (auth: Auth, provider: AuthProvider): Promise<UserCredential> => (provider.providerId === 'google.com' ? googlePopup(auth) : noPopup(provider));
export const signInWithRedirect = async (_auth: Auth, provider: AuthProvider): Promise<never> => noPopup(provider);
/** Re-auth with Google: a fresh Google sign-in that must land on the same account. */
export const reauthenticateWithPopup = async (user: User, provider: AuthProvider): Promise<UserCredential> => {
  if (provider.providerId !== 'google.com') return noPopup(provider);
  const cred = await googlePopup(getAuth());
  if (cred.user.uid !== user.uid) throw Object.assign(new Error('That Google account is not the signed-in one'), { code: 'auth/user-mismatch', name: 'FirebaseError' });
  return cred;
};

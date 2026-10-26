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

/** Google / Microsoft sign-in is not on this server yet (TaskManager signs in by e-mail link here). */
const noPopup = (provider: AuthProvider): never => {
  throw Object.assign(new Error(`${provider.providerId} sign-in is not available on this server; use the e-mail link`), { code: 'auth/operation-not-allowed', name: 'FirebaseError' });
};
export const signInWithPopup = async (_auth: Auth, provider: AuthProvider): Promise<UserCredential> => noPopup(provider);
export const signInWithRedirect = async (_auth: Auth, provider: AuthProvider): Promise<never> => noPopup(provider);
export const reauthenticateWithPopup = async (_user: User, provider: AuthProvider): Promise<UserCredential> => noPopup(provider);

/**
 * Identity, behind one port (types.ts): IceBase's auth (getAdminAuth) — Firebase Auth on
 * Firebase, the IceBase server's own sign-in on it (TM_ICEBASE). Everything above this file
 * calls identity(); nothing above it knows who issues the tokens.
 */
import { firebaseIdentity } from './firebase.js';
import type { Identity } from './types.js';

export * from './types.js';

/** The identity service (verify tokens, read and manage accounts). */
export function identity(): Identity {
  return firebaseIdentity();
}

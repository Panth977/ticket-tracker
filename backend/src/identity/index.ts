/**
 * Identity, behind one port (types.ts). TM_AUTH (else TM_PLATFORM) picks the
 * adapter once, at startup:
 *
 *   'firebase' (firebase)  Firebase Auth (emulator-aware)
 *   'local'    (vm)        accounts in the database port — identity/local
 *
 * Everything above this file calls identity(); nothing above it knows who
 * issues the tokens.
 */
import { adapterFor } from '../runtime/platform.js';
import { firebaseIdentity } from './firebase.js';
import { localIdentity } from './local/accounts.js';
import type { Identity } from './types.js';

export * from './types.js';

export type IdentityKind = 'firebase' | 'local';

/** Who issues identities here: TM_AUTH, else the platform's. */
export function identityKind(): IdentityKind {
  return adapterFor<IdentityKind>('TM_AUTH', { firebase: 'firebase', vm: 'local' }, [
    'firebase',
    'local',
  ]);
}

const local = identityKind() === 'local';

/** The identity service (verify tokens, read and manage accounts). */
export function identity(): Identity {
  return local ? localIdentity : firebaseIdentity();
}

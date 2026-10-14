/** The Firebase adapter: Firebase Auth itself. The port is a subset of its API — no wrapper. */
import { auth } from '../runtime/firebase.js';
import type { Identity } from './types.js';

export const firebaseIdentity = (): Identity => auth() as unknown as Identity;

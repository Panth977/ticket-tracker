/** The identity suite on Firebase Auth (the emulator): the reference answers. */
import '../harness/env.js';
import { firebaseIdentity } from '../../src/identity/firebase.js';
import { mintEmulatorIdToken } from '../harness/users.js';
import { identitySuite } from './suite.js';

identitySuite('firebase', firebaseIdentity, mintEmulatorIdToken);

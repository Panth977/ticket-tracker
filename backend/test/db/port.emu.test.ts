/** The port suite on the Firestore adapter (the emulator): the reference answers. */
import '../harness/env.js';
import { firestoreAdapter } from '../../src/db/firestore.js';
import { portSuite } from './suite.js';

portSuite('firestore', () => firestoreAdapter);

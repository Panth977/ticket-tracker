/** The rtdb suite on Firebase's Realtime Database (the emulator): the reference. */
import '../harness/env.js';
import { firebaseRtdb } from '../../src/rtdb/firebase.js';
import { rtdbSuite } from './suite.js';
rtdbSuite(
  'firebase',
  () => firebaseRtdb.db(),
  () => firebaseRtdb.TIMESTAMP,
);

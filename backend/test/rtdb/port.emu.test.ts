/** The rtdb suite on IceBase's Realtime Database (Firebase's, the emulator here). */
import '../harness/env.js';
import { icebaseRtdb } from '../../src/rtdb/icebase.js';
import { rtdbSuite } from './suite.js';
rtdbSuite(
  'icebase',
  () => icebaseRtdb.db(),
  () => icebaseRtdb.TIMESTAMP,
);

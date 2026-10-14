/** The blob suite on Cloud Storage (the emulator): the reference answers. */
import '../harness/env.js';
import { gcsAdapter } from '../../src/blob/gcs.js';
import { blobSuite } from './suite.js';

blobSuite('gcs', () => gcsAdapter.bucket(), { signs: false, preconditions: false });

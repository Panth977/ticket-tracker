/**
 * The `bucketDelete` queue handler (queued by bucketDelete and by account
 * deletion). The work is bucket/purge.ts.
 */
import { purgeBucket } from '../bucket/purge.js';
import { defineTask } from '../runtime/functions.js';

defineTask('bucketDelete', async ({ bucketId }) => {
  await purgeBucket(bucketId);
});

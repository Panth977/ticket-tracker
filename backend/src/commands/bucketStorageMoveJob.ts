/** The `bucketStorageMove` queue handler: one slice of a move (bucket/drive/move.ts). */
import { runMoveSlice } from '../bucket/drive/move.js';
import { defineTask } from '../runtime/functions.js';

defineTask('bucketStorageMove', async ({ bucketId, round }, meta) => {
  await runMoveSlice(bucketId, round, meta?.retryCount ?? 0);
});

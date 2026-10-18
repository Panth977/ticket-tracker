/** The `bucketStorageMove` queue handler: one slice of a move (bucket/drive/move.ts). */
import { runMoveSlice } from '../bucket/drive/move.js';
import { defineTask } from '../runtime/functions.js';

defineTask('bucketStorageMove', async ({ bucketId, round }) => {
  await runMoveSlice(bucketId, round);
});

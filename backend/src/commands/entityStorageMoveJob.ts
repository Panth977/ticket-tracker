/** The `entityStorageMove` queue handler: one slice of a move (db/drive/entityMove.ts). */
import { runEntityMoveSlice } from '../db/drive/entityMove.js';
import { defineTask } from '../runtime/functions.js';

defineTask('entityStorageMove', async ({ kind, id, round }, meta) => {
  await runEntityMoveSlice(kind, id, round, meta?.retryCount ?? 0);
});

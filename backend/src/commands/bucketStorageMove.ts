/**
 * bucketStorageMove (bucket.html §K6) — move a bucket's files to the other
 * storage (managed ⇄ my Google Drive). The work is a queued job
 * (bucketStorageMoveJob.ts, bucket/drive/move.ts); this starts it.
 */
import { startMove } from '../bucket/drive/move.js';
import { defineCommand } from './_registry.js';

export default defineCommand('bucketStorageMove', async (ctx, { bucketId, to }) => {
  const { total } = await startMove(ctx, bucketId, to);
  return { ok: true as const, total };
});

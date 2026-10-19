/**
 * bucketStorageMove (bucket.html §K6) — move a bucket's files to the other
 * storage (managed ⇄ my Google Drive). The work is a queued job
 * (bucketStorageMoveJob.ts, bucket/drive/move.ts); this starts it.
 */
import { errors } from '@tm/shared';
import { resumeMove, startMove } from '../bucket/drive/move.js';
import { defineCommand } from './_registry.js';

export default defineCommand('bucketStorageMove', async (ctx, { bucketId, to, resume }) => {
  if (resume) return { ok: true as const, ...(await resumeMove(ctx, bucketId)) };
  if (!to) throw errors.invalid('Say where to move it', { field: 'to' });
  const { total } = await startMove(ctx, bucketId, to);
  return { ok: true as const, total };
});

/**
 * entityStorageMove (bucket.html §L4) — move a board, a dictionary or an
 * artifact to the other storage (the database ⇄ my Google Drive). The work is
 * a queued job (entityStorageMoveJob.ts, db/drive/entityMove.ts); this starts it.
 */
import { errors } from '@tm/shared';
import { resumeEntityMove, startEntityMove } from '../db/drive/entityMove.js';
import { defineCommand } from './_registry.js';

export default defineCommand('entityStorageMove', async (ctx, { kind, id, to, resume }) => {
  if (resume) return { ok: true as const, ...(await resumeEntityMove(ctx, kind, id)) };
  if (!to) throw errors.invalid('Say where to move it', { field: 'to' });
  const { total } = await startEntityMove(ctx, kind, id, to);
  return { ok: true as const, total };
});

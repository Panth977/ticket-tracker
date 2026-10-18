/**
 * boardStorageMove (bucket.html §L4) — move a board's tickets to the other
 * storage (the database ⇄ my Google Drive). The work is a queued job
 * (boardStorageMoveJob.ts, db/drive/boardMove.ts); this starts it.
 */
import { errors } from '@tm/shared';
import { resumeBoardMove, startBoardMove } from '../db/drive/boardMove.js';
import { defineCommand } from './_registry.js';

export default defineCommand('boardStorageMove', async (ctx, { boardId, to, resume }) => {
  if (resume) return { ok: true as const, ...(await resumeBoardMove(ctx, boardId)) };
  if (!to) throw errors.invalid('Say where to move it', { field: 'to' });
  const { total } = await startBoardMove(ctx, boardId, to);
  return { ok: true as const, total };
});

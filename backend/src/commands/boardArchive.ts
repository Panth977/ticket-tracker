/**
 * boardArchive — can(admin).
 *
 *   archive  archivedAt = now: read-only for everyone, off the sidebar,
 *            under 'Archived' on Boards
 *   restore  archivedAt = null
 *   delete   confirmKey must equal the key (400 otherwise). The board doc goes
 *            now — nobody can read it from this moment — and a queued job
 *            (boardDeleteJob.ts) deletes tickets, threads and files. The key
 *            stays claimed: boardKeys/{key} and keys/ are kept as tombstones so
 *            old #links say 'deleted' and the key is never reissued.
 */
import { errors } from '@tm/shared';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { afterBoardDeleted, boardRef, deleteBoardTx, loadBoard } from './boardShared.js';

export default defineCommand('boardArchive', async (ctx, { boardId, action, confirmKey }) => {
  await runTx(async (tx) => {
    const board = await loadBoard(tx, boardId, ctx, 'admin');
    switch (action) {
      case 'archive':
        if (board.archivedAt === null) tx.update(boardRef(boardId), { archivedAt: ctx.now });
        return;
      case 'restore':
        if (board.archivedAt !== null) tx.update(boardRef(boardId), { archivedAt: null });
        return;
      case 'delete':
        if (confirmKey !== board.key)
          throw errors.invalid(`Type the board key (${board.key}) to confirm`, {
            field: 'confirmKey',
          });
        deleteBoardTx(tx, board);
        return;
    }
  });
  if (action === 'delete') await afterBoardDeleted(boardId, ctx);
  return { ok: true as const };
});

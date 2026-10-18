/** The `boardStorageMove` queue handler: one slice of a move (db/drive/boardMove.ts). */
import { runBoardMoveSlice } from '../db/drive/boardMove.js';
import { defineTask } from '../runtime/functions.js';

defineTask('boardStorageMove', async ({ boardId, round }, meta) => {
  await runBoardMoveSlice(boardId, round, meta?.retryCount ?? 0);
});

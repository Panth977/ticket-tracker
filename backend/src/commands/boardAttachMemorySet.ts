/**
 * boardAttachMemorySet (memory.html §J) — where a file put on one of this
 * board's tickets goes by default: one of the memories granted `write` to the
 * board, and a path template (tickets/<ticketId>/<time>_<filename>). null
 * clears it (the attach dialog then asks; server-side uploads are refused).
 *
 *   can(admin) on the board; never an agent; board not archived
 *   the memory exists, is not being deleted, and boards[boardId] === 'write'
 *
 * Kept true afterwards: memoryGrantSet clears it when that write grant goes
 * (removed or lowered to read), memoryDelete when the memory goes.
 */
import { errors, isAgentId } from '@tm/shared';
import { memoryRef } from '../memory/shared.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { assertActive, boardRef, loadBoard } from './boardShared.js';

export default defineCommand('boardAttachMemorySet', async (ctx, { boardId, attachMemory }) => {
  if (isAgentId(ctx.actor)) throw errors.forbidden('An agent cannot change board settings');
  await runTx(async (tx) => {
    const board = await loadBoard(tx, boardId, ctx, 'admin');
    assertActive(board);
    if (attachMemory) {
      const memory = await txGet(tx, memoryRef(attachMemory.memoryId));
      if (!memory || memory.deletingAt) throw errors.not_found('Memory not found');
      if (memory.boards?.[boardId] !== 'write')
        throw errors.invalid(
          'Attachments need a memory this board may write — grant it write in board settings › Memory',
          { field: 'attachMemory.memoryId' },
        );
    }
    tx.update(boardRef(boardId), { attachMemory, updatedAt: ctx.now });
  });
  return { ok: true as const };
});

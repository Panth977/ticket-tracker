/**
 * tasklistDelete (docs/plan/agents.html §L2).
 *
 *   canEditTasklist() on the STORED list — editor+, or its owner.
 *   Deleting is silent: no thread line, no activity row. The ticket's roll-up
 *   chip is recomputed from the lists that remain — one write (§W).
 */
import { errors } from '@tm/shared';
import { canEditTasklist } from '@tm/shared/logic/index';
import { runTx } from '../runtime/tx.js';
import { loadBoard, requireWritableBoard } from '../tickets/access.js';
import { openTicket } from '../tickets/doc.js';
import { defineCommand } from './_registry.js';

export default defineCommand('tasklistDelete', async (ctx, input) => {
  const { boardId, ticketId, listId } = input;
  const board = await loadBoard(ctx, boardId);
  requireWritableBoard(board);

  await runTx(async (tx) => {
    // ── reads ── (an archived ticket may still be tidied up: no requireActive)
    const w = await openTicket(tx, ctx, boardId, ticketId);
    const stored = w.tasklist(listId);
    if (!stored) throw errors.not_found('Task list not found');
    if (!canEditTasklist(ctx, board, stored))
      throw errors.forbidden('You cannot change this task list');

    // ── writes ──
    w.removeTasklist(listId);
    w.touch();
    w.commit();
  });
  return { ok: true as const };
});

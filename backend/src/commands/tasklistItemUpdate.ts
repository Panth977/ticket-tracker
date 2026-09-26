/**
 * tasklistItemUpdate — ONE item's status and note (docs/plan/agents.html §L2).
 *
 * The hot path: an agent calls this as it works, and people tick items by
 * hand through the same command. NO activity row and NO thread line — 'every
 * change to an item does not, to keep the thread readable'.
 *
 * The one exception is the list FINISHING: when this tick settles the last
 * item, the list closes and the second (and last) system line goes out, which
 * is the same line tasklistSet writes for an explicit close.
 *
 * Phase 15 (§W): one write on the ticket document, which also refreshes the
 * '4/7' chip and signals.tasklist.working that the card renders.
 */
import { errors, tasklistComplete, type StoredTasklist, type TaskItem } from '@tm/shared';
import { canEditTasklist } from '@tm/shared/logic/index';
import { runTx } from '../runtime/tx.js';
import { loadBoard, requireActive, requireWritableBoard } from '../tickets/access.js';
import { openTicket } from '../tickets/doc.js';
import { writeTasklistLine } from '../tickets/tasklists.js';
import { actorName } from '../tickets/writes.js';
import { defineCommand } from './_registry.js';

export default defineCommand('tasklistItemUpdate', async (ctx, input) => {
  const { boardId, ticketId, listId, itemId } = input;
  const board = await loadBoard(ctx, boardId);
  requireWritableBoard(board);

  await runTx(async (tx) => {
    // ── reads ──
    const w = await openTicket(tx, ctx, boardId, ticketId);
    requireActive(w.before);
    const stored = w.tasklist(listId);
    if (!stored) throw errors.not_found('Task list not found');
    if (!canEditTasklist(ctx, board, stored))
      throw errors.forbidden('You cannot change this task list');
    const i = stored.items.findIndex((it) => it.id === itemId);
    if (i < 0) throw errors.not_found('That item is not on this list');

    const before = stored.items[i]!;
    const item: TaskItem = {
      ...before,
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: ctx.now,
    };
    // null clears the note; absent leaves it.
    if (input.note === null) delete (item as Partial<TaskItem>).note;
    else if (input.note !== undefined) item.note = input.note;

    const items = [...stored.items];
    items[i] = item;
    const wasClosed = stored.closedAt !== null;
    const finished = !wasClosed && tasklistComplete({ items });
    const list: StoredTasklist = {
      ...stored,
      items,
      updatedAt: ctx.now,
      closedAt: finished ? ctx.now : stored.closedAt,
    };

    // ── writes ──
    w.setTasklist(list);
    if (finished) writeTasklistLine(w, ctx, await actorName(ctx, boardId), 'finished', list.title);
    w.touch();
    w.commit();
  });
  return { ok: true as const, updatedAt: ctx.now };
});

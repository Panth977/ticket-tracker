/**
 * tasklistSet — create or REPLACE a whole task list (docs/plan/agents.html §L2).
 *
 *   canEditTasklist() — editor+, or the list's own owner (a commenter agent
 *     through its token with tasklists:write). Creating one sets owner = the
 *     actor; replacing one keeps the owner it already has.
 *   the ticket must be active (409); ≤ 100 items (the shared schema)
 *
 *   ONE write (§W): ticket.tasklists holds the list, tasklistProgress /
 *     signals.tasklist are rolled up over every list on the ticket, and a
 *     system line goes in the thread when the list is CREATED and a second
 *     when it is FINISHED — never for an item.
 *
 * Whole-list writes are how an agent republishes its plan without diffing it;
 * ids are kept so an item that did not change keeps its updatedAt.
 */
import { errors, tasklistComplete, type StoredTasklist } from '@tm/shared';
import { canEditTasklist } from '@tm/shared/logic/index';
import { runTx } from '../runtime/tx.js';
import { loadBoard, requireActive, requireWritableBoard } from '../tickets/access.js';
import { openTicket } from '../tickets/doc.js';
import { mergeItems, nextPosition, writeTasklistLine } from '../tickets/tasklists.js';
import { actorName } from '../tickets/writes.js';
import { defineCommand } from './_registry.js';

export default defineCommand('tasklistSet', async (ctx, input) => {
  const { boardId, ticketId } = input;
  const board = await loadBoard(ctx, boardId);
  requireWritableBoard(board);
  const byName = await actorName(ctx, boardId);

  return runTx(async (tx) => {
    // ── reads ──
    const w = await openTicket(tx, ctx, boardId, ticketId);
    requireActive(w.before);
    const listId = input.listId ?? ctx.ids.shortId();
    const previous = w.tasklist(listId);
    const owner = previous?.owner ?? ctx.actor;
    if (!canEditTasklist(ctx, board, { owner }))
      throw errors.forbidden('You cannot change this task list');

    const items = mergeItems(input.items, previous?.items ?? [], ctx.now, () => ctx.ids.shortId());
    const position =
      input.position ??
      previous?.position ??
      nextPosition(w.tasklists().filter((l) => l.id !== listId));

    // 'closed' states it outright; otherwise a list that has nothing left to do
    // closes itself, which is what puts the second system line in the thread.
    const wasClosed = previous?.closedAt != null;
    const closed = input.closed ?? (wasClosed || tasklistComplete({ items }));
    const list: StoredTasklist = {
      id: listId,
      title: input.title,
      owner,
      items,
      position,
      createdAt: previous?.createdAt ?? ctx.now,
      updatedAt: ctx.now,
      closedAt: closed ? (previous?.closedAt ?? ctx.now) : null,
    };

    // ── writes ──
    w.setTasklist(list);
    if (!previous) writeTasklistLine(w, ctx, byName, 'added', list.title);
    if (!wasClosed && list.closedAt !== null)
      writeTasklistLine(w, ctx, byName, 'finished', list.title);
    w.touch();
    w.commit();

    return { listId, itemIds: items.map((i) => i.id) };
  });
});

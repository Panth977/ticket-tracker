/**
 * messageReact (app/backend.json services.messageReact).
 *
 *   can(comment); the actor is added to / removed from reactions[emoji]
 *   no notification — a reaction is not a message
 *
 * Phase 15 (§W): reactions live on a row inside the ticket document, so the
 * emoji is an ordinary object key on a value we rewrite whole — there is no
 * field path to get wrong any more, and a '.' in an emoji name can no longer
 * address a different field. An empty list is dropped rather than stored.
 */
import { runTx } from '../runtime/tx.js';
import { loadBoard, requireActive, requireCan, requireWritableBoard } from '../tickets/access.js';
import { openTicket } from '../tickets/doc.js';
import { loadMessage, requireNotDeleted } from '../tickets/thread.js';
import { defineCommand } from './_registry.js';

export default defineCommand('messageReact', async (ctx, input) => {
  const { boardId, ticketId, messageId, emoji, on } = input;
  const board = await loadBoard(ctx, boardId);
  requireCan(ctx, board, 'comment');
  requireWritableBoard(board);

  await runTx(async (tx) => {
    const w = await openTicket(tx, ctx, boardId, ticketId);
    requireActive(w.before);
    const found = await loadMessage(w, messageId);
    requireNotDeleted(found.message);
    const before = found.message.reactions[emoji] ?? [];
    const next = on ? [...new Set([...before, ctx.actor])] : before.filter((u) => u !== ctx.actor);
    if (next.length === before.length && next.every((u, i) => u === before[i])) return;
    const reactions = { ...found.message.reactions };
    if (next.length) reactions[emoji] = next;
    else delete reactions[emoji];
    w.patchMessage(found, { reactions });
    w.commit();
  });
  return { ok: true as const };
});

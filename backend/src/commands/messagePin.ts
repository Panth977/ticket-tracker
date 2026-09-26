/**
 * messagePin (app/backend.json services.messagePin).
 *
 *   can(pin) = editor+ (the reference gated pin on 'edit'); ticket active
 *   pinnedAt / pinnedBy set or cleared; ticket.counts.pinned ±1
 *   a system line 'Priya pinned a message' quoting it (replyTo) — pins are
 *   decisions, and who made one belongs in the thread
 *   webhook message.pinned on pin
 *
 * Pinning what is already pinned (or unpinning what is not) is a no-op.
 *
 * Phase 15 (§W): the pin, the counter and the system line are one write on the
 * ticket document. A pinned message also STAYS inline (tickets/doc.ts
 * mustStayInline), so the thread's pinned strip and the API's
 * `pinned_messages` come out of the document nobody had to query for.
 */
import { runTx } from '../runtime/tx.js';
import { loadBoard, requireActive, requireCan, requireWritableBoard } from '../tickets/access.js';
import { openTicket } from '../tickets/doc.js';
import { emitSafe } from '../tickets/effects.js';
import { toPublicMessage } from '../platform/public.js';
import { loadMessage, requireNotDeleted } from '../tickets/thread.js';
import { actorName, richFromInline, systemMessage } from '../tickets/writes.js';
import { defineCommand } from './_registry.js';

export default defineCommand('messagePin', async (ctx, input) => {
  const { boardId, ticketId, messageId, pinned } = input;
  const board = await loadBoard(ctx, boardId);
  requireCan(ctx, board, 'pin');
  requireWritableBoard(board);
  const byName = await actorName(ctx, boardId);

  const res = await runTx(async (tx) => {
    const w = await openTicket(tx, ctx, boardId, ticketId);
    requireActive(w.before);
    const found = await loadMessage(w, messageId);
    requireNotDeleted(found.message);
    if ((found.message.pinnedAt !== null) === pinned) return null; // already so

    const next = w.patchMessage(found, {
      pinnedAt: pinned ? ctx.now : null,
      pinnedBy: pinned ? ctx.actor : null,
    });
    const line = systemMessage(
      ctx,
      byName,
      richFromInline([
        { type: 'text', text: `${byName} ${pinned ? 'pinned' : 'unpinned'} a message` },
      ]),
    );
    w.addMessage(ctx.ids.id(), { ...line, replyTo: messageId });
    w.commit();
    return { key: w.before.key, msg: next };
  });

  if (res && pinned) {
    await emitSafe(
      boardId,
      'message.pinned',
      () => toPublicMessage(boardId, res.key, messageId, res.msg, ticketId),
      ctx,
    );
  }
  return { ok: true as const };
});

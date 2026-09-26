/**
 * questionCancel (docs/plan/agents.html §L1).
 *
 *   the ASKER (the message author — usually the agent, through its token) or a
 *   board admin. Open questions only: an answered, cancelled or expired one is
 *   409. The card locks as cancelled and nobody is notified again.
 *
 *   ONE write (§W): question.status 'cancelled' + cancelledAt on the row, and
 *     waitingOn / signals follow. No thread line: the card itself says it.
 *   after commit: the asking agent's inbox event question_cancelled — only
 *     when somebody ELSE cancelled it (an agent's own actions never reach its
 *     own inbox, §D).
 */
import { errors, questionStatus, type Question } from '@tm/shared';
import { can } from '@tm/shared/logic/index';
import { runTx } from '../runtime/tx.js';
import { loadBoard, requireWritableBoard, withTicketId } from '../tickets/access.js';
import { openTicket } from '../tickets/doc.js';
import { afterCommit } from '../tickets/effects.js';
import { askedAgentOf, questionEventPayload } from '../tickets/questions.js';
import { loadMessage, requireNotDeleted } from '../tickets/thread.js';
import { actorName } from '../tickets/writes.js';
import { agentSummary, writeAgentEvents } from '../agents/inbox.js';
import { defineCommand } from './_registry.js';

export default defineCommand('questionCancel', async (ctx, input) => {
  const { boardId, ticketId, messageId } = input;
  const board = await loadBoard(ctx, boardId);
  requireWritableBoard(board);

  const res = await runTx(async (tx) => {
    // ── reads ──
    const w = await openTicket(tx, ctx, boardId, ticketId);
    const ticket = w.before;
    const found = await loadMessage(w, messageId);
    const card = found.message;
    requireNotDeleted(card);
    if (card.kind !== 'question' || !card.question)
      throw errors.not_found('That message is not a question');

    const mine = card.authorUid === ctx.actor && can(ctx, board, 'ask');
    if (!mine && !can(ctx, board, 'admin'))
      throw errors.forbidden('Only the asker or a board admin can cancel a question');

    const shown = questionStatus(card.question, ctx.now);
    if (shown !== 'open') throw errors.conflict(`This question is ${shown}`, { status: shown });

    const cancelled: Question = { ...card.question, status: 'cancelled', cancelledAt: ctx.now };

    // ── writes ──
    w.patchMessage(found, { question: cancelled });
    w.dropCarry(messageId);
    w.touch();
    w.commit();
    return { ticket, card, cancelled };
  });

  // ── after commit ──
  const agentId = askedAgentOf(res.card, ctx.actor);
  if (agentId) {
    const byName = await actorName(ctx, boardId);
    const t = withTicketId(boardId, ticketId, res.ticket);
    await afterCommit('agentInbox:question_cancelled', () =>
      writeAgentEvents('question_cancelled', t, ctx, [agentId], {
        messageId,
        summary: agentSummary(byName, `cancelled “${res.cancelled.title}”`, t.key),
        question: questionEventPayload(ticketId, messageId, res.cancelled),
      }),
    );
  }
  return { ok: true as const };
});

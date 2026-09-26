/**
 * questionAnswer (docs/plan/agents.html §L1).
 *
 *   canAnswerQuestion() — commenter+ with questions:write, in the question's
 *     `to` when it names anyone, and the question still open at ctx.now
 *     (409 'answered' / 'cancelled' / 'expired')
 *   values are checked against the fields by the SHARED validateAnswer, so the
 *     browser can disable Submit for the same reason the server answers 422
 *
 *   ONE write (§W): the card locks in place (question.status 'answered' + the
 *     answer); the answer ALSO posts as the person's reply bubble (§L1), which
 *     is an ordinary comment with replyTo = the card; counters and
 *     waitingOn / signals follow from the rows themselves
 *   after commit: the asking agent's inbox event question_answered, carrying
 *     the values — 'an agent needs no second call to act on it'
 *
 * Only a PERSON may answer: an agent asks, a person answers, and the asker can
 * never answer its own question.
 */
import { errors, isAgentId, type Message, type Question } from '@tm/shared';
import { canAnswerQuestion, validateAnswer } from '@tm/shared/logic/index';
import { runTx } from '../runtime/tx.js';
import { loadBoard, requireActive, requireWritableBoard, withTicketId } from '../tickets/access.js';
import { openTicket } from '../tickets/doc.js';
import { afterCommit, emitSafe } from '../tickets/effects.js';
import { answerBody, askedAgentOf, markRead, questionEventPayload } from '../tickets/questions.js';
import { loadMessage, requireNotDeleted } from '../tickets/thread.js';
import { toPublicMessage } from '../platform/public.js';
import { actorName, viaTokenOf } from '../tickets/writes.js';
import { agentSummary, writeAgentEvents } from '../agents/inbox.js';
import { defineCommand } from './_registry.js';

export default defineCommand('questionAnswer', async (ctx, input) => {
  const { boardId, ticketId, messageId } = input;
  const board = await loadBoard(ctx, boardId);
  requireWritableBoard(board);
  // An agent never answers — not even one that may comment (§L1).
  if (isAgentId(ctx.actor)) throw errors.forbidden('Agents do not answer questions');
  const byName = await actorName(ctx, boardId);

  const res = await runTx(async (tx) => {
    // ── reads ──
    const w = await openTicket(tx, ctx, boardId, ticketId);
    const ticket = w.before;
    requireActive(ticket);
    const found = await loadMessage(w, messageId);
    const card = found.message;
    requireNotDeleted(card);
    if (card.kind !== 'question' || !card.question)
      throw errors.not_found('That message is not a question');
    const q = card.question;
    if (!canAnswerQuestion(ctx, board, q, ctx.now)) {
      // Open but not for you → 403; no longer open → 409 naming the status.
      if (q.status !== 'open')
        throw errors.conflict(`This question is ${q.status}`, { status: q.status });
      if (q.expiresAt !== null && q.expiresAt <= ctx.now)
        throw errors.conflict('This question expired', { status: 'expired' });
      throw errors.forbidden('You cannot answer this question');
    }

    const check = validateAnswer(q, input.values, input.comment);
    if (!check.ok)
      throw errors.unprocessable('That answer does not fit the question', { issues: check.issues });

    const answered: Question = {
      ...q,
      status: 'answered',
      answer: {
        values: check.values,
        ...(input.comment ? { comment: input.comment } : {}),
        by: ctx.actor,
        at: ctx.now,
      },
    };
    // ── writes ──
    w.patchMessage(found, { question: answered });
    w.dropCarry(messageId);
    // The reply bubble: the answer as the person said it, quoting the card.
    const replyId = ctx.ids.id();
    const reply: Message = {
      kind: 'comment',
      body: answerBody(q, check.values, input.comment),
      authorUid: ctx.actor,
      authorName: byName,
      via: ctx.via,
      ...viaTokenOf(ctx),
      replyTo: messageId,
      attachments: [],
      reactions: {},
      pinnedAt: null,
      pinnedBy: null,
      editedAt: null,
      deletedAt: null,
      createdAt: ctx.now,
    };
    w.addMessage(replyId, reply);
    w.set({ watcherUids: [...new Set([...ticket.watcherUids, ctx.actor])] });
    const after = w.commit();
    markRead(tx, ctx.actor, boardId, ticketId, ctx.now);
    return { ticket: after, card, answered, reply, replyId };
  });

  // ── after commit ──
  const t = withTicketId(boardId, ticketId, res.ticket);
  const agentId = askedAgentOf(res.card, ctx.actor);
  if (agentId) {
    await afterCommit('agentInbox:question_answered', () =>
      writeAgentEvents('question_answered', t, ctx, [agentId], {
        messageId,
        summary: agentSummary(byName, `answered “${res.answered.title}”`, t.key),
        question: questionEventPayload(ticketId, messageId, res.answered),
      }),
    );
  }
  await emitSafe(
    boardId,
    'message.created',
    () => toPublicMessage(boardId, t.key, res.replyId, res.reply, ticketId),
    ctx,
  );
  return { ok: true as const, answeredAt: ctx.now };
});

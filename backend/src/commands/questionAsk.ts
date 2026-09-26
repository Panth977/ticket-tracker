/**
 * questionAsk (docs/plan/agents.html §L1).
 *
 *   can(ask) — commenter+, usually an agent's token with questions:write
 *   the ticket must be active (a closed thread takes no questions → 409)
 *   `to` must name principals that are ON the board (400)
 *   fields are 1–10, with option lists on single / multi (the shared schema)
 *
 *   ONE write (§W): the question is a row in ticket.recentMessages (kind
 *     'question', payload in `question`); counts.messages / lastMessageAt /
 *     watcherUids ∪= asker; refs ∪= the context's #refs (+ the backlink on
 *     each target, like a comment); waitingOn / signals.question when it
 *     blocks, and nextQuestionExpiresAt so the expiry sweep can find it
 *   after commit: notify('question') to the `to` people — or, when it names
 *     nobody, the assignees and watchers — through their normal channels;
 *     notify('mentioned') for @mentions in the context that are not already
 *     hearing about it as the question's recipients; webhook message.created
 *
 * The message id is the request's clientId, exactly like messagePost, so the
 * optimistic bubble, a retry and the realtime listener all agree on it.
 */
import { errors, questionId, type Message, type Question } from '@tm/shared';
import { runTx } from '../runtime/tx.js';
import {
  loadBoard,
  requireActive,
  requireCan,
  requireWritableBoard,
  withTicketId,
} from '../tickets/access.js';
import { openTicket } from '../tickets/doc.js';
import { emitSafe, notifySafe } from '../tickets/effects.js';
import { markRead, questionBody, questionRecipients } from '../tickets/questions.js';
import { readRefTargets, writeReferences } from '../tickets/references.js';
import { parseBody, type ParsedBody } from '../tickets/richtext.js';
import { toPublicMessage } from '../platform/public.js';
import { isMember } from '../tickets/validate.js';
import { actorName, viaTokenOf } from '../tickets/writes.js';
import { defineCommand } from './_registry.js';

export default defineCommand('questionAsk', async (ctx, input) => {
  const { boardId, ticketId } = input;
  const board = await loadBoard(ctx, boardId);
  requireCan(ctx, board, 'ask');
  requireWritableBoard(board);

  // Who should answer must be on this board — otherwise the card waits forever.
  const to = input.to?.length ? [...new Set(input.to)] : null;
  const strangers = (to ?? []).filter((id) => !isMember(board, id));
  if (strangers.length)
    throw errors.invalid(`Not on this board: ${strangers.join(', ')}`, { field: 'to' });

  const context: ParsedBody | null = input.body
    ? await parseBody(input.body, board, ctx, ticketId)
    : null;
  const body = questionBody(input.title, context?.rich ?? null);
  const byName = await actorName(ctx, boardId);

  const question: Question = {
    title: input.title,
    body: context?.rich ?? null,
    fields: input.fields,
    allowComment: input.allowComment ?? false,
    to,
    // §L1: blocking is the default — an agent that asks is usually stuck.
    blocking: input.blocking ?? true,
    status: 'open',
    expiresAt: input.expiresAt ?? null,
    answer: null,
    cancelledAt: null,
  };
  if (question.expiresAt !== null && question.expiresAt <= ctx.now)
    throw errors.invalid('expiresAt is already in the past', { field: 'expiresAt' });

  const res = await runTx(async (tx) => {
    // ── reads ──
    const w = await openTicket(tx, ctx, boardId, ticketId);
    const ticket = w.before;
    requireActive(ticket);
    let messageId = input.clientId ?? ctx.ids.id();
    const existing = w.find(messageId);
    if (existing) {
      // Our own retry: the same card, not a second one.
      if (existing.authorUid === ctx.actor && existing.kind === 'question')
        return { replay: true as const, messageId, ticket, message: existing };
      messageId = ctx.ids.id();
    }
    const newRefs = (context?.rich.refs ?? []).filter((r) => !ticket.refs.includes(r));
    const targets = await readRefTargets(tx, newRefs, context?.refAt ?? new Map());
    const message: Message = {
      kind: 'question',
      body,
      authorUid: ctx.actor,
      authorName: byName,
      via: ctx.via,
      ...viaTokenOf(ctx),
      replyTo: null,
      attachments: [],
      reactions: {},
      pinnedAt: null,
      pinnedBy: null,
      editedAt: null,
      deletedAt: null,
      createdAt: ctx.now,
      question,
    };
    // ── writes ── waitingOn / signals / nextQuestionExpiresAt follow from the
    // row itself: TicketWriter derives them at commit (tickets/doc.ts).
    w.addMessage(messageId, message);
    w.set({ watcherUids: [...new Set([...ticket.watcherUids, ctx.actor])] });
    if (targets.length)
      w.set({ refs: [...new Set([...ticket.refs, ...targets.map((t) => t.id)])] });
    const after = w.commit();
    markRead(tx, ctx.actor, boardId, ticketId, ctx.now);
    writeReferences(tx, ctx, { id: ticketId, key: ticket.key, boardId }, targets, {
      systemLine: { byName },
    });
    return { replay: false as const, messageId, ticket: after, message };
  });
  const id = questionId(ticketId, res.messageId);
  if (res.replay) return { messageId: res.messageId, questionId: id };

  // ── after commit ──
  const t = withTicketId(boardId, ticketId, res.ticket);
  const asked = questionRecipients(question, t, ctx.actor);
  await notifySafe('question', t, ctx, { recipients: asked, messageId: res.messageId });
  const mentioned = (context?.rich.mentions ?? []).filter(
    (u) => u !== ctx.actor && !asked.includes(u),
  );
  await notifySafe('mentioned', t, ctx, { mentioned, messageId: res.messageId });
  await emitSafe(
    boardId,
    'message.created',
    // Phase 3: with the ticket id the webhook payload carries the form card.
    () => toPublicMessage(boardId, t.key, res.messageId, res.message, ticketId),
    ctx,
  );
  return { messageId: res.messageId, questionId: id };
});

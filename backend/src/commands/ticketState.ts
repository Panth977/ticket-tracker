/**
 * ticketState (app/backend.json services.ticketState).
 *
 *   active → archived : can(state)
 *   archived → active : can(restore)   (admin)
 *   activity + system message; after commit notify('state') + webhook ticket.state
 *
 * Phase 6: archive is the only reversible close (delete is permanent and
 * lives in ticketDelete), and no reason is asked for either way.
 *
 * System lines count in counts.messages but do not move lastMessageAt: a
 * state change is not a reason to mark the thread unread for everyone.
 */
import { errors } from '@tm/shared';
import { runTx } from '../runtime/tx.js';
import { openTicket } from '../tickets/doc.js';
import { loadBoard, requireCan, requireWritableBoard, withTicketId } from '../tickets/access.js';
import { emitSafe, notifySafe } from '../tickets/effects.js';
import { toPublicTicket } from '../platform/public.js';
import { stateAction, writeStateChange } from '../tickets/state.js';
import { actorName } from '../tickets/writes.js';
import { defineCommand } from './_registry.js';

export default defineCommand('ticketState', async (ctx, input) => {
  const { boardId, ticketId, state: to } = input;
  const board = await loadBoard(ctx, boardId);
  requireWritableBoard(board);
  const byName = await actorName(ctx, boardId);

  const { before, next } = await runTx(async (tx) => {
    const w = await openTicket(tx, ctx, boardId, ticketId);
    const ticket = w.before;
    requireCan(
      ctx,
      board,
      stateAction(ticket.state),
      null,
      null,
      ticket.state === 'active'
        ? 'You cannot archive tickets on this board'
        : 'Only an admin can restore a ticket',
    );
    if (ticket.state === to) throw errors.conflict(`This ticket is already ${to}`, { state: to });
    writeStateChange(w, ctx, ticket.state, to, byName);
    return { before: ticket, next: w.commit() };
  });

  const after = withTicketId(boardId, ticketId, next);
  await notifySafe('state', after, ctx, { changes: { state: { from: before.state, to } } });
  await emitSafe(boardId, 'ticket.state', () => toPublicTicket(board, after), ctx);
  return { ok: true as const };
});

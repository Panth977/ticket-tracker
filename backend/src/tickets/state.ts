/**
 * The ticket lifecycle, ORTHOGONAL to the stage: active → archived needs
 * can(state); archived → active needs can(restore) — admin, as in the
 * reference. Every change writes an activity row and a system line in the
 * thread; shared by ticketState and ticketBulk.
 *
 * Phase 6: 'cancelled' is gone (archive covers 'out of the way', delete
 * covers 'gone for good') and with it the reason — nobody could read a
 * reason on a ticket they can no longer see.
 *
 * Phase 15 (§W): all three land on the one ticket document.
 */
import { can } from '@tm/shared/logic/index';
import type { BoardWithId, TicketState } from '@tm/shared';
import type { ServerCtx } from '../runtime/context.js';
import type { TicketWriter } from './doc.js';
import { activityDoc, richFromInline, systemMessage } from './writes.js';

export function stateAction(from: TicketState): 'state' | 'restore' {
  return from === 'active' ? 'state' : 'restore';
}

/** May the actor take a ticket from `from` to `to`? (from !== to is the caller's check.) */
export const canChangeState = (ctx: ServerCtx, board: BoardWithId, from: TicketState): boolean =>
  can(ctx, board, stateAction(from));

const VERB: Record<TicketState, string> = {
  active: 'restored',
  archived: 'archived',
};

/**
 * The state, its activity row and its system line, staged on one ticket.
 *
 * A system line counts in counts.messages but does NOT move lastMessageAt: a
 * state change is not a reason to mark the thread unread for everyone
 * (TicketWriter.addMessage knows this from the message's kind).
 */
export function writeStateChange(
  w: TicketWriter,
  ctx: ServerCtx,
  from: TicketState,
  to: TicketState,
  byName: string,
): void {
  w.set({ state: to, updatedAt: ctx.now });
  w.addActivity(activityDoc(ctx, 'state', { state: { from, to } }));
  w.addMessage(
    ctx.ids.id(),
    systemMessage(
      ctx,
      byName,
      richFromInline([{ type: 'text', text: `${byName} ${VERB[to]} this ticket` }]),
    ),
  );
  w.touch();
}

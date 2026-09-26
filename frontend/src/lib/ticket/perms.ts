/**
 * What the signed-in person may do on this ticket — the SAME can() the server
 * runs (shared logic/can), used here only to hide or disable controls. The
 * server stays the authority; a stale answer just means a refused command.
 */
import { can, roleOf } from '@tm/shared/logic/index';
import type { BoardRole, BoardWithId, Ticket } from '@tm/shared';

export interface TicketPerms {
  role: BoardRole | null;
  /** Every field, title, description. */
  edit: boolean;
  comment: boolean;
  pin: boolean;
  /** Archive. */
  state: boolean;
  /** Back to active (admin). */
  restore: boolean;
  /** Hard delete (board opt-in + admin). */
  delete: boolean;
  /** Stages this person may move the ticket TO (all for editors). */
  moveTo: (stageId: string) => boolean;
  /** The ticket is archived: read-only, thread closed. */
  closed: boolean;
}

export const NO_PERMS: TicketPerms = {
  role: null,
  edit: false,
  comment: false,
  pin: false,
  state: false,
  restore: false,
  delete: false,
  moveTo: () => false,
  closed: false,
};

export function ticketPerms(
  board: Pick<BoardWithId, 'id' | 'access' | 'stageGrants' | 'settings'> | null | undefined,
  ticket: Pick<Ticket, 'stageId' | 'assigneeUids' | 'state'> | null | undefined,
  uid: string | null | undefined,
): TicketPerms {
  if (!board || !uid) return NO_PERMS;
  const ctx = { actor: uid };
  const closed = !!ticket && ticket.state !== 'active';
  const open = (a: Parameters<typeof can>[2]) => !closed && can(ctx, board, a, ticket);
  return {
    role: roleOf(board, uid),
    edit: open('edit'),
    comment: open('comment'),
    pin: open('pin'),
    state: open('state'),
    restore: closed && can(ctx, board, 'restore'),
    delete: can(ctx, board, 'delete'),
    moveTo: (to) =>
      !closed && !!ticket && (can(ctx, board, 'edit') || can(ctx, board, 'move', ticket, to)),
    closed,
  };
}

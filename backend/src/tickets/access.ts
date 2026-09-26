/**
 * Loading a board / ticket and asking can() the way every ticket command does.
 *
 * NEVER LEAK EXISTENCE: a board the actor cannot read (not on it, or a token
 * narrowed to other boards) answers 404, exactly like a board that does not
 * exist. Only an actor who CAN read the board learns 403 for what they may
 * not do.
 */
import type { DocumentReference } from 'firebase-admin/firestore';
import { can, type Action, type CanCtx, type CanTicket } from '@tm/shared/logic/index';
import {
  errors,
  paths,
  type Board,
  type BoardWithId,
  type Ticket,
  type TicketWithId,
} from '@tm/shared';
import { typedDoc } from '../runtime/converters.js';
import { getDoc, txGet, type Tx } from '../runtime/tx.js';

export const boardRef = (boardId: string): DocumentReference<Board> =>
  typedDoc('boards', paths.board(boardId));

export const ticketRef = (boardId: string, ticketId: string): DocumentReference<Ticket> =>
  typedDoc('tickets', paths.ticket(boardId, ticketId));

export const withBoardId = (id: string, b: Board): BoardWithId => ({ ...b, id });
export const withTicketId = (boardId: string, id: string, t: Ticket): TicketWithId => ({
  ...t,
  id,
  boardId,
});

/** Read a board (in a transaction when given); 404 when missing or unreadable. */
export async function loadBoard(ctx: CanCtx, boardId: string, tx?: Tx): Promise<BoardWithId> {
  const ref = boardRef(boardId);
  const data = tx ? await txGet(tx, ref) : await getDoc(ref);
  if (!data) throw errors.not_found('Board not found');
  const board = withBoardId(boardId, data);
  if (!can(ctx, board, 'read')) throw errors.not_found('Board not found');
  return board;
}

/**
 * The board for INTAKE_ACTOR (intake widget / email-to-board): the actor is on
 * no board, so there is no can(read) — but the door narrows ctx.boardIds to
 * the one board its intake points at, and that narrowing is required.
 */
export async function loadBoardForIntake(ctx: CanCtx, boardId: string): Promise<BoardWithId> {
  if (!ctx.boardIds?.includes(boardId)) throw errors.not_found('Board not found');
  const data = await getDoc(boardRef(boardId));
  if (!data) throw errors.not_found('Board not found');
  return withBoardId(boardId, data);
}

/** Read a ticket on a board the caller already loaded; 404 when missing. */
export async function loadTicket(
  boardId: string,
  ticketId: string,
  tx?: Tx,
): Promise<TicketWithId> {
  const ref = ticketRef(boardId, ticketId);
  const data = tx ? await txGet(tx, ref) : await getDoc(ref);
  if (!data) throw errors.not_found('Ticket not found');
  return withTicketId(boardId, ticketId, data);
}

/**
 * can() or throw: 404 when the actor cannot even read the board, 403 when
 * they can read it but not do this.
 */
export function requireCan(
  ctx: CanCtx,
  board: BoardWithId,
  action: Action,
  ticket?: CanTicket | null,
  toStageId?: string | null,
  message?: string,
): void {
  if (can(ctx, board, action, ticket, toStageId)) return;
  if (!can(ctx, board, 'read')) throw errors.not_found('Board not found');
  throw errors.forbidden(message ?? `You cannot ${action} on this board`);
}

/** An archived board is read-only for everyone until it is restored. */
export function requireWritableBoard(board: BoardWithId): void {
  if (board.archivedAt !== null) throw errors.conflict('This board is archived and read-only');
}

/** Archived tickets are read-only; their threads are closed. */
export function requireActive(ticket: Pick<Ticket, 'state'>): void {
  if (ticket.state !== 'active') {
    throw errors.conflict(`This ticket is ${ticket.state} and read-only — restore it first`, {
      state: ticket.state,
    });
  }
}

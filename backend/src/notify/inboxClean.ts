/**
 * KEEPING THE UNREAD NUMBER HONEST. A board's number in the sidebar is the
 * count of my unread inbox rows for it (users/{uid}/inbox, readAt == null);
 * nothing else decides it. So a row about a ticket that is gone, archived, or
 * that I have read since must not stay unread:
 *
 *   clearTicketInbox   when a ticket is deleted or archived, everyone's
 *                      unread rows about it are marked read (after commit)
 *   reconcileInbox     daily (housekeeping): every unread row is checked
 *                      against its ticket, its board and the person's read
 *                      pointer — a mistake anywhere cannot pile up for long
 */
import {
  ARTIFACT_INVITE_BOARD_ID,
  SILENT_EVENTS,
  paths,
  type Board,
  type InboxItem,
  type NotifyEvent,
  type Ticket,
} from '@tm/shared';
import { db } from '../runtime/firebase.js';

/** Mark every person's unread rows about this ticket read. Never throws. */
export async function clearTicketInbox(
  boardId: string,
  ticketId: string,
  now: number,
): Promise<number> {
  try {
    const board = (await db().doc(paths.board(boardId)).get()).data() as Board | undefined;
    const uids = new Set([...(board?.readerUids ?? []), ...Object.keys(board?.access ?? {})]);
    let n = 0;
    await Promise.all(
      [...uids].map(async (uid) => {
        const s = await db()
          .collection(paths.inbox(uid))
          .where('ticketId', '==', ticketId)
          .where('readAt', '==', null)
          .get();
        for (const d of s.docs) {
          await d.ref.update({ readAt: now });
          n++;
        }
      }),
    );
    return n;
  } catch (e) {
    console.error('[inbox] clearTicketInbox failed', boardId, ticketId, e);
    return 0;
  }
}

/** Why a row should no longer count as unread, or null when it should. */
export function staleReason(
  row: Pick<InboxItem, 'event' | 'boardId' | 'ticketId' | 'createdAt'>,
  board: Pick<Board, 'archivedAt'> | null | undefined,
  ticket: Pick<Ticket, 'state'> | null | undefined,
  readAt: number | null | undefined,
): string | null {
  if (SILENT_EVENTS.includes(row.event as NotifyEvent)) return 'silent';
  if (row.boardId === ARTIFACT_INVITE_BOARD_ID) return null;
  if (!board) return 'board gone';
  if (board.archivedAt) return 'board archived';
  if (!row.ticketId) return null;
  if (!ticket) return 'ticket gone';
  if (ticket.state !== 'active') return 'ticket archived';
  if (readAt != null && readAt >= row.createdAt) return 'read since';
  return null;
}

/** Daily: every unread row, checked; the stale ones marked read. Returns how many. */
export async function reconcileInbox(now: number): Promise<number> {
  const rows = await db().collectionGroup('inbox').where('readAt', '==', null).get();
  const boards = new Map<string, Promise<Board | null>>();
  const tickets = new Map<string, Promise<Ticket | null>>();
  const boardOf = (id: string) => {
    let p = boards.get(id);
    if (!p) {
      p = db()
        .doc(paths.board(id))
        .get()
        .then((s) => (s.exists ? (s.data() as Board) : null))
        .catch(() => null);
      boards.set(id, p);
    }
    return p;
  };
  const ticketOf = (boardId: string, id: string) => {
    const k = `${boardId}/${id}`;
    let p = tickets.get(k);
    if (!p) {
      // A failed read is not 'gone': undefined keeps the row as it is.
      p = db()
        .doc(paths.ticket(boardId, id))
        .get()
        .then((s) => (s.exists ? (s.data() as Ticket) : null));
      tickets.set(k, p);
    }
    return p;
  };
  let n = 0;
  for (const d of rows.docs) {
    const row = d.data() as InboxItem;
    const uid = d.ref.parent.parent?.id;
    if (!uid) continue;
    try {
      const board = row.boardId === ARTIFACT_INVITE_BOARD_ID ? null : await boardOf(row.boardId);
      const ticket =
        board && row.ticketId && !board.archivedAt
          ? await ticketOf(row.boardId, row.ticketId)
          : null;
      const read =
        ticket && row.ticketId
          ? ((await db().doc(paths.read(uid, row.ticketId)).get()).get('readAt') as
              number | undefined)
          : undefined;
      const why = staleReason(row, board, ticket, read);
      if (!why) continue;
      await d.ref.update({ readAt: now });
      n++;
    } catch (e) {
      console.warn('[inbox] reconcile: row kept', d.ref.path, e);
    }
  }
  return n;
}

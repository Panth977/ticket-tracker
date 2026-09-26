/**
 * The app's common live queries, shaped so security rules can prove them
 * (boards: readerUids array-contains me; invites: email == mine; views:
 * shared ∪ mine). Use these instead of hand-writing the same query, so every
 * screen shares one listener per query.
 */
import { derived, type Readable } from 'svelte/store';
import {
  paths,
  type Board,
  type BoardMember,
  type BoardPref,
  type InboxItem,
  type Invite,
  type Read,
  type Ticket,
  type View,
} from '@tm/shared';
import { notePointer } from '$lib/boot/pointer';
import { readSession } from '$lib/boot/session';
import { deltaQueryStore } from './delta';
import { docStore, queryStore, type QueryState, type WithId } from './live';

/**
 * Every board I am on (archived included — filter on archivedAt).
 *
 * §T: the resolved list is also the pointer lib/boot/prewarm needs next time —
 * which boards to subscribe to before the server answers. Writing it here (and
 * not in the sidebar) means every screen that asks keeps it fresh, and
 * notePointer is a no-op when nothing changed.
 */
export function myBoards(uid: string | null | undefined): Readable<QueryState<Board>> {
  const q = queryStore<Board>(
    uid ? { path: paths.boards(), where: [['readerUids', 'array-contains', uid]] } : null,
  );
  if (!uid) return q;
  return derived(q, (s) => {
    if (!s.loading && !s.error)
      notePointer(uid, { boards: s.data.map((b) => ({ id: b.id, key: b.key })) });
    return s;
  });
}

/** One board by its key ('ENG'), among the boards I can read. */
export function boardByKey(
  uid: string | null | undefined,
  key: string | null | undefined,
): Readable<{ loading: boolean; error: Error | null; board: WithId<Board> | null }> {
  const q = queryStore<Board>(
    uid && key
      ? {
          path: paths.boards(),
          where: [
            ['readerUids', 'array-contains', uid],
            ['key', '==', key.toUpperCase()],
          ],
          limit: 1,
        }
      : null,
  );
  return derived(q, (s) => {
    const board = s.data[0] ?? null;
    // §T: remember which board to warm next boot (see myBoards above).
    if (board && uid) notePointer(uid, { board: { id: board.id, key: board.key } });
    return { loading: s.loading, error: s.error, board };
  });
}

/** Pending invitations addressed to my (verified, lower-cased) email. */
export function myInvites(email: string | null | undefined): Readable<QueryState<Invite>> {
  return queryStore<Invite>(
    email
      ? {
          path: paths.invites(),
          where: [
            ['email', '==', email.toLowerCase()],
            ['status', '==', 'pending'],
          ],
        }
      : null,
  );
}

/** Unread, un-archived inbox rows (capped at 100 — the badge says 99+). */
export function inboxUnread(uid: string | null | undefined): Readable<QueryState<InboxItem>> {
  return queryStore<InboxItem>(
    uid
      ? {
          path: paths.inbox(uid),
          where: [
            ['readAt', '==', null],
            ['archivedAt', '==', null],
          ],
          limit: 100,
        }
      : null,
  );
}

/** My per-board preferences (starred, notify mode, lastViewId). */
export function boardPref(boardId: string | null | undefined, uid: string | null | undefined) {
  return docStore<BoardPref>(boardId && uid ? paths.pref(boardId, uid) : null);
}

/** A board's views I can see: shared ∪ my personal ones, by position. */
export function boardViews(
  boardId: string | null | undefined,
  uid: string | null | undefined,
): Readable<QueryState<View>> {
  const shared = queryStore<View>(
    boardId ? { path: paths.views(boardId), where: [['scope', '==', 'shared']] } : null,
  );
  const mine = queryStore<View>(
    boardId && uid
      ? {
          path: paths.views(boardId),
          where: [
            ['scope', '==', 'personal'],
            ['ownerUid', '==', uid],
          ],
        }
      : null,
  );
  return derived([shared, mine], ([a, b]) => ({
    loading: a.loading || b.loading,
    error: a.error ?? b.error,
    fromCache: a.fromCache || b.fromCache,
    data: [...a.data, ...b.data].sort(
      (x, y) => x.position - y.position || x.name.localeCompare(y.name),
    ),
  }));
}

/**
 * A board's members. Same spec as the board page's own query, so the two share
 * one listener — and so lib/boot/prewarm can open it before the page mounts.
 */
export function boardMembers(
  boardId: string | null | undefined,
): Readable<QueryState<BoardMember>> {
  return queryStore<BoardMember>(boardId ? { path: paths.members(boardId) } : null);
}

/**
 * The board's live cards: everything not archived or done (state == 'active').
 *
 * §W — INCREMENTAL. The first open of a board is one query of its active
 * tickets; every open after that seeds from Firestore's persistent cache and
 * asks only for `updatedAt > watermark` (./delta), so an unchanged board costs
 * one read however many cards it has. The rows, and the overlays on them, are
 * exactly what the plain listener handed out.
 *
 * `uid` keys the watermark (lib/boot/pointer, per account). It is optional
 * because the board page and the boot prewarm both already know it, and a
 * caller that does not falls back to the remembered session — the same uid the
 * pointer itself is filed under.
 */
export function boardActiveTickets(
  boardId: string | null | undefined,
  uid?: string | null,
): Readable<QueryState<Ticket>> {
  const who = uid ?? readSession()?.uid ?? null;
  if (!boardId) return queryStore<Ticket>(null);
  // Without an account there is nowhere to keep a watermark: plain listener.
  if (!who)
    return queryStore<Ticket>({
      path: paths.tickets(boardId),
      where: [['state', '==', 'active']],
    });
  return deltaQueryStore<Ticket>({
    key: 'tickets:' + boardId,
    path: paths.tickets(boardId),
    uid: who,
    scope: boardId,
    cold: [['state', '==', 'active']],
    stamp: 'updatedAt',
    // A ticket that was archived or deleted-then-restored arrives in the delta
    // and is dropped here; 'cancelled' is the pre-phase-6 spelling of archived.
    keep: (t) => t.state === 'active',
  });
}

/** My read marks on one board — what makes a card look unread. */
export function boardReads(
  boardId: string | null | undefined,
  uid: string | null | undefined,
): Readable<QueryState<Read>> {
  return queryStore<Read>(
    boardId && uid ? { path: paths.reads(uid), where: [['boardId', '==', boardId]] } : null,
  );
}

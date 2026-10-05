/**
 * THE DRAWER'S DATA — all of it out of ONE document (docs/plan/agents.html §W).
 *
 * Phase 15 folded the ticket's four subcollections into the ticket itself, so
 * opening a ticket the board already drew costs NOTHING: the thread, the pins,
 * the question cards, the task lists, the activity feed and the files are
 * fields of `boards/{b}/tickets/{t}`, and the board list already read it. The
 * stores below therefore keep the names and the shapes the drawer has always
 * used — `QueryState<Message>`, `QueryState<Tasklist>`, … — but every one of
 * them is a DERIVATION of the single `ticketDoc` listener rather than a query
 * of its own.
 *
 *   threadPage    the newest `count` messages: the inline window, then a data
 *                 page at a time as someone scrolls back past it
 *   pinnedMessages / questionMessages   inline by design (§W keeps pins and
 *                 open questions in the window however long the thread gets)
 *   ticketTasklists / ticketFiles       whole arrays on the document
 *   activityFeed  the same paging as the thread
 *
 * WHAT STILL COSTS A READ. `data/{NNN}` — the frozen older pages — and only
 * when a reader asks for something older than `oldestInlineAt`. A page is
 * written once and then only ever touched by an edit of a message inside it,
 * so it is fetched once per tab and kept (see `pageCache`).
 *
 * 'Seen by' is still a collection-group query on `reads` (a handful of tiny
 * documents, one per person who opened the ticket) — that is not the ticket's
 * data, it is everybody else's read pointer.
 */
import {
  collectionGroup,
  doc,
  getDoc,
  onSnapshot,
  query,
  where as fsWhere,
} from 'firebase/firestore';
import { derived, readable, type Readable } from 'svelte/store';
import {
  inlineActivity,
  inlineFiles,
  inlineMessages,
  inlineTasklists,
  isQuestionMessage,
  paths,
  type Board,
  type BoardMember,
  type KeyIndex,
  type Message,
  type Read,
  type StoredActivity,
  type StoredMessage,
  type Tasklist,
  type Ticket,
  type TicketDataPage,
  type TicketFile,
} from '@tm/shared';
import { getDb } from '$lib/firebase/client';
import { countReads, firstServerSnapshot } from '$lib/stores/reads';
import { docStore, queryStore, type DocState, type QueryState, type WithId } from '$lib/stores';
import { applyOverlays } from '$lib/stores/overlay';

/** Messages load newest-first in pages of this size (architecture › limits: 'Paged 50 at a time'). */
export const PAGE = 50;

export const keyIndex = (key: string | null | undefined) =>
  docStore<KeyIndex>(key ? paths.key(key.toUpperCase()) : null);
export const ticketDoc = (
  boardId: string | null | undefined,
  ticketId: string | null | undefined,
) => docStore<Ticket>(boardId && ticketId ? paths.ticket(boardId, ticketId) : null);
export const boardDoc = (boardId: string | null | undefined) =>
  docStore<Board>(boardId ? paths.board(boardId) : null);
export const boardMembers = (boardId: string | null | undefined) =>
  queryStore<BoardMember>(boardId ? { path: paths.members(boardId) } : null);

const EMPTY_QUERY: QueryState<never> = {
  loading: false,
  error: null,
  data: [],
  fromCache: false,
};

const idle = <T>(): Readable<QueryState<T>> => readable(EMPTY_QUERY as QueryState<T>);

/**
 * Turn a ticket's document state into a list state, so every derived store
 * below reports loading / error / fromCache exactly as a query used to.
 */
function asQuery<T extends { id: string }>(
  s: DocState<Ticket>,
  rows: (t: WithId<Ticket>) => T[],
): QueryState<T> {
  return {
    loading: s.loading,
    error: s.error,
    fromCache: s.fromCache,
    // Every stored row already carries its own id (§W: an array element has no
    // document id), which is exactly what WithId<T> asks for.
    data: (s.data ? rows(s.data) : []) as WithId<T>[],
  };
}

/**
 * A row's optimistic overlay. Commands still address a message, a task list or
 * a file by its own path (paths.message / tasklist / file) — that is where
 * outbox.queue puts the patch — but since §W the row is an array element of
 * the ticket, so no listener renders that path. Applying it here, per row, is
 * what makes a reaction, a pin, an edit or a ticked item show at once instead
 * of after the round trip (and keeps a quick second click from starting from
 * the old value). The ticket store re-emits on every overlay change, so these
 * derivations re-run when one is added or rolled back.
 */
function overlaid<R extends { id: string }>(rows: R[], pathOf: (id: string) => string): R[] {
  const out: R[] = [];
  for (const r of rows) {
    const v = applyOverlays(pathOf(r.id), r);
    if (v) out.push(v); // a null patch hides the row
  }
  return out;
}

/** A list read straight off the open ticket — no listener of its own. */
function ofTicket<T extends { id: string }>(
  boardId: string | null | undefined,
  ticketId: string | null | undefined,
  rows: (t: WithId<Ticket>) => T[],
): Readable<QueryState<T>> {
  if (!boardId || !ticketId) return idle<T>();
  return derived(ticketDoc(boardId, ticketId), (s) => asQuery(s, rows));
}

// ─────────────────────────── the older pages ────────────────────────────────

/**
 * data/{NNN}, fetched once per tab. A page is FROZEN when it is written, so
 * caching the promise is safe; the one exception (an edit of a message inside
 * an old page) is rare enough that it may wait for a reload, and the inline
 * window — where every message anybody is likely to edit lives — is live.
 */
const pageCache = new Map<string, Promise<TicketDataPage | null>>();

/**
 * Drop the fetched pages. Sign-out (the device forgets the account) and tests
 * are the callers; nothing in a normal session needs it, because a page cannot
 * change without an edit of a message inside it.
 */
export function forgetTicketPages(): void {
  pageCache.clear();
}

function loadPage(boardId: string, ticketId: string, n: number): Promise<TicketDataPage | null> {
  const path = paths.ticketPage(boardId, ticketId, n);
  let p = pageCache.get(path);
  if (!p) {
    p = getDoc(doc(getDb(), path))
      .then((s) => {
        countReads('page:' + path, 1);
        return s.exists() ? (s.data() as TicketDataPage) : null;
      })
      .catch(() => {
        pageCache.delete(path); // a transient failure must be retryable
        return null;
      });
    pageCache.set(path, p);
  }
  return p;
}

interface Row {
  id: string;
  createdAt: number;
}

/**
 * The newest `count` rows of a paged stream: the inline window first and a
 * `data/{NNN}` page at a time behind it, newest page first, until there are
 * enough or the thread starts. Newest-first, which is the order the thread and
 * the activity feed have always been handed.
 *
 * `loading` stays false while older pages are on their way: the rows we have
 * are real and already on screen, and the caller's 'Load earlier' button is
 * what the wait belongs to.
 */
function pagedStream<R extends Row>(
  boardId: string | null | undefined,
  ticketId: string | null | undefined,
  count: number,
  inline: (t: Ticket) => R[],
  fromPage: (p: TicketDataPage) => R[],
  pathOf: ((id: string) => string) | null,
): Readable<QueryState<R>> {
  if (!boardId || !ticketId) return idle<R>();
  const tk = ticketDoc(boardId, ticketId);
  return readable<QueryState<R>>(
    { loading: true, error: null, data: [], fromCache: false },
    (set) => {
      let alive = true;
      let state: DocState<Ticket> | null = null;
      /** Pages already in hand, by page number. */
      const have = new Map<number, R[]>();
      let fetching = false;

      /** How many rows we hold, and the newest page we have not fetched yet. */
      const held = (t: Ticket) =>
        inline(t).length + [...have.values()].reduce((n, rows) => n + rows.length, 0);
      const missing = (t: Ticket) => {
        let n = (t.pageCount ?? 0) - 1;
        while (n >= 0 && have.has(n)) n--;
        return n; // < 0 = the start of the thread is in hand
      };

      const emit = () => {
        const s = state;
        if (!s) return;
        const q = asQuery(s, (t) => {
          const older: R[] = [];
          for (const n of [...have.keys()].sort((a, b) => a - b)) older.push(...have.get(n)!);
          const rows = [...older, ...inline(t)];
          const all = pathOf ? overlaid(rows, pathOf) : rows;
          // Newest first, and only as many as were asked for.
          return all.slice(Math.max(0, all.length - count)).reverse();
        });
        // Still loading while a page we are going to ask for is missing: that
        // is what keeps 'Load earlier' from flickering away and back.
        const more = !!s.data && held(s.data) < count && missing(s.data) >= 0;
        set({ ...q, loading: q.loading || more });
      };

      /** Pull pages back from the newest until `count` rows are in hand. */
      const fill = async () => {
        if (fetching) return;
        fetching = true;
        try {
          for (;;) {
            const t = state?.data;
            if (!alive || !t) return;
            if (held(t) >= count) return;
            const next = missing(t);
            if (next < 0) return; // the start of the thread
            const page = await loadPage(boardId, ticketId, next);
            if (!alive) return;
            // An absent page is remembered as empty, so a gap cannot loop.
            have.set(next, page ? fromPage(page) : []);
            emit();
          }
        } finally {
          fetching = false;
        }
      };

      const off = tk.subscribe((s) => {
        state = s;
        emit();
        if (!s.loading && s.data) void fill();
      });
      return () => {
        alive = false;
        off();
      };
    },
  );
}

// ─────────────────────────────── the thread ─────────────────────────────────

/**
 * The newest `count` messages. The inline window holds the last ~100–200 of
 * them, so 'Load earlier' costs nothing until someone goes back past it.
 */
export const threadPage = (boardId: string | null, ticketId: string | null, count: number) =>
  pagedStream<StoredMessage>(
    boardId,
    ticketId,
    count,
    (t) => inlineMessages(t),
    (p) => p.messages,
    (id) => paths.message(boardId!, ticketId!, id),
  ) as Readable<QueryState<Message>>;

/**
 * §W keeps every PINNED message in the inline window however long the thread
 * gets ('pins are decisions'), so the pinned strip is a filter, not a query —
 * a pin from five years ago still floats at the top.
 */
export const pinnedMessages = (boardId: string | null, ticketId: string | null) =>
  ofTicket<WithId<Message>>(boardId, ticketId, (t) =>
    overlaid(inlineMessages(t), (id) => paths.message(boardId!, ticketId!, id))
      .filter((m) => m.pinnedAt != null)
      .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0))
      .slice(0, 20),
  ) as Readable<QueryState<Message>>;

/**
 * The ticket's QUESTION CARDS (§L1) — the ❓ Waiting badge in the header must
 * be right even when the open question is older than the page that is loaded.
 * §W keeps open questions inline for exactly that reason.
 */
export const questionMessages = (boardId: string | null, ticketId: string | null) =>
  ofTicket<WithId<Message>>(boardId, ticketId, (t) =>
    overlaid(inlineMessages(t), (id) => paths.message(boardId!, ticketId!, id)).filter((m) =>
      isQuestionMessage(m),
    ),
  ) as Readable<QueryState<Message>>;

/** The ticket's task lists (§L2), in `position` order (top of the right pane). */
export const ticketTasklists = (boardId: string | null, ticketId: string | null) =>
  ofTicket<WithId<Tasklist>>(boardId, ticketId, (t) =>
    overlaid(inlineTasklists(t), (id) => paths.tasklist(boardId!, ticketId!, id)),
  ) as Readable<QueryState<Tasklist>>;

/** The activity feed, newest first — paged like the thread. */
export const activityFeed = (boardId: string | null, ticketId: string | null, count = 100) =>
  pagedStream<StoredActivity>(
    boardId,
    ticketId,
    count,
    (t) => inlineActivity(t),
    (p) => p.activity,
    null,
  ) as Readable<QueryState<StoredActivity>>;

/**
 * Every file row on the ticket, newest first, tombstones included — the Files
 * tab and the viewer filter them. `ticket.files` carries the lot (§W): the
 * Files tab is part of the ticket, not a second query.
 */
export const ticketFiles = (boardId: string | null, ticketId: string | null) =>
  ofTicket<WithId<TicketFile>>(boardId, ticketId, (t) =>
    overlaid(inlineFiles(t), (id) => paths.file(boardId!, ticketId!, id)).reverse(),
  ) as Readable<QueryState<TicketFile>>;

export const myRead = (uid: string | null | undefined, ticketId: string | null | undefined) =>
  docStore<Read>(uid && ticketId ? paths.read(uid, ticketId) : null);

/** Everyone's read pointer on this ticket ('Seen by'): users/{uid}/reads/{ticketId}, by collection group. */
export function ticketReads(
  boardId: string | null,
  ticketId: string | null,
): Readable<{ uid: string; readAt: number }[]> {
  if (!boardId || !ticketId) return readable([]);
  const bill = firstServerSnapshot('seenBy:' + ticketId);
  return readable<{ uid: string; readAt: number }[]>([], (set) =>
    onSnapshot(
      query(
        collectionGroup(getDb(), 'reads'),
        fsWhere('boardId', '==', boardId),
        fsWhere('ticketId', '==', ticketId),
      ),
      (snap) => {
        if (!snap.metadata.fromCache) bill(snap.docChanges().length);
        set(
          snap.docs
            .map((d) => ({ uid: d.ref.parent.parent?.id ?? '', readAt: (d.data() as Read).readAt }))
            .filter((r) => r.uid),
        );
      },
      () => set([]), // rules or a missing index: 'Seen by' falls back to presence
    ),
  );
}

// ───────────────────────── tickets referenced by id ─────────────────────────

export type Located =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'found'; ticket: WithId<Ticket>; boardId: string };

const where = new Map<string, Promise<string | null>>();

/**
 * Which board holds ticket `id`? Links and referencedBy carry only the id, and
 * the client cannot list keys/ or query tickets across boards — so try the
 * current board, then every other board I can read. Not found anywhere =
 * 'a ticket you can't see'.
 */
function findBoard(id: string, boardIds: readonly string[]): Promise<string | null> {
  const k = id + '|' + boardIds.join(',');
  let p = where.get(k);
  if (!p) {
    p = (async () => {
      for (const b of boardIds) {
        try {
          const s = await getDoc(doc(getDb(), paths.ticket(b, id)));
          countReads('locate:' + id, 1);
          if (s.exists()) return b;
        } catch {
          /* not readable: keep looking */
        }
      }
      return null;
    })();
    where.set(k, p);
    // A miss is retried later (I may be given a role on its board).
    void p.then((b) => {
      if (!b) setTimeout(() => where.delete(k), 30_000);
    });
  }
  return p;
}

/** A related ticket, live once located. */
export function locatedTicket(id: string, boardIds: readonly string[]): Readable<Located> {
  return readable<Located>({ status: 'loading' }, (set) => {
    let off: (() => void) | null = null;
    let alive = true;
    void findBoard(id, boardIds).then((b) => {
      if (!alive) return;
      if (!b) return set({ status: 'hidden' });
      off = docStore<Ticket>(paths.ticket(b, id)).subscribe((s: DocState<Ticket>) => {
        if (s.loading) return;
        set(s.data ? { status: 'found', ticket: s.data, boardId: b } : { status: 'hidden' });
      });
    });
    return () => {
      alive = false;
      off?.();
    };
  });
}

/** uid → member row, for pickers and names. */
export function membersById(members: Readable<QueryState<BoardMember>>) {
  return derived(members, (m) => new Map(m.data.map((x) => [x.uid, x])));
}

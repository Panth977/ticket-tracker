/**
 * THE TICKET DOCUMENT, READ SIDE (docs/plan/agents.html §W).
 *
 * Every read that used to be a query of boards/{b}/tickets/{t}/messages (or
 * /activity, /files, /tasklists) is now a field of the ticket document the
 * caller already has — and a data page only when someone asks for something
 * older than the inline window.
 *
 *   readThread   the thread, ascending or descending, with the same
 *                (createdAt, id) cursor the REST API has always used
 *   getMessage   one message by id, inline or paged
 *   readFiles / readTasklists / readActivity / pinnedMessages / questionMessages
 *
 * The shapes handed back are exactly the shapes the old queries handed back —
 * `{ id, message }` pairs and `Tasklist` rows — so the REST and MCP answers do
 * not change. Agents in production must not notice.
 */
import {
  paths,
  type StoredActivity,
  type StoredMessage,
  type StoredTasklist,
  type Ticket,
  type TicketDataPage,
  type TicketFile,
} from '@tm/shared';
import { typedDoc } from '../runtime/converters.js';
import { getDoc, type Tx } from '../runtime/tx.js';
import {
  inlineActivity,
  inlineFiles,
  inlineMessages,
  inlineTasklists,
  isOpenQuestion,
  pageRef,
} from './doc.js';

const ticketDoc = (boardId: string, ticketId: string) =>
  typedDoc('tickets', paths.ticket(boardId, ticketId));

/** The ticket, or undefined. Most callers already hold it and pass it in. */
async function ticketOf(
  boardId: string,
  ticketId: string,
  given?: Ticket,
): Promise<Ticket | undefined> {
  return given ?? (await getDoc(ticketDoc(boardId, ticketId)));
}

/** Total order: (createdAt, id) — the same order the composite index gave. */
const cmp = (a: { createdAt: number; id: string }, b: { createdAt: number; id: string }): number =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export interface ThreadCursor {
  createdAt: number;
  id: string;
}

export interface ThreadQuery {
  /** The ticket, when the caller already read it (saves one read). */
  ticket?: Ticket;
  limit?: number;
  order?: 'asc' | 'desc';
  /** Strictly after this row, in `order`. */
  after?: ThreadCursor | null;
  /** Include system lines and tombstones (the thread does; search does not). */
  tx?: Tx;
}

async function loadPage(
  boardId: string,
  ticketId: string,
  n: number,
  tx?: Tx,
): Promise<TicketDataPage | undefined> {
  const ref = pageRef(boardId, ticketId, n);
  if (tx) {
    const s = await tx.get(ref);
    return s.exists ? s.data() : undefined;
  }
  return getDoc(ref);
}

/**
 * The thread as a page of messages, oldest or newest first.
 *
 * The inline window is a contiguous NEWEST run and pages 000…N-1 hold
 * everything older in order, so ascending is 'pages then inline' and
 * descending is 'inline then pages, backwards'. A page whose whole range
 * falls on the wrong side of the cursor is never fetched.
 */
export async function readThread(
  boardId: string,
  ticketId: string,
  q: ThreadQuery = {},
): Promise<{ rows: StoredMessage[]; hasMore: boolean; total: number }> {
  const t = await ticketOf(boardId, ticketId, q.ticket);
  if (!t) return { rows: [], hasMore: false, total: 0 };
  const limit = q.limit ?? Number.MAX_SAFE_INTEGER;
  const order = q.order ?? 'asc';
  const after = q.after ?? null;
  const pageCount = t.pageCount ?? 0;
  const inline = inlineMessages(t);

  const keep = (m: StoredMessage) =>
    !after || (order === 'asc' ? cmp(m, after) > 0 : cmp(m, after) < 0);

  const out: StoredMessage[] = [];
  const take = (rows: readonly StoredMessage[]) => {
    const sorted = order === 'asc' ? rows : [...rows].reverse();
    for (const m of sorted) {
      if (!keep(m)) continue;
      out.push(m);
      if (out.length > limit) return true;
    }
    return false;
  };

  const order0 = order === 'asc';
  const pageNumbers = order0
    ? [...Array(pageCount).keys()]
    : [...Array(pageCount).keys()].reverse();
  const sources: (() => Promise<readonly StoredMessage[] | null>)[] = [];
  const pageSource = (n: number) => async () => {
    const p = await loadPage(boardId, ticketId, n, q.tx);
    return p ? p.messages : null;
  };
  if (order0) {
    for (const n of pageNumbers) sources.push(pageSource(n));
    sources.push(async () => inline);
  } else {
    sources.push(async () => inline);
    for (const n of pageNumbers) sources.push(pageSource(n));
  }

  for (const src of sources) {
    const rows = await src();
    if (!rows || !rows.length) continue;
    // A page entirely on the wrong side of the cursor cannot contribute.
    if (take(rows)) break;
  }
  const hasMore = out.length > limit;
  return { rows: hasMore ? out.slice(0, limit) : out, hasMore, total: t.counts.messages };
}

/** Every message on the ticket, oldest first (export, reindex of a long thread). */
export async function readAllMessages(
  boardId: string,
  ticketId: string,
  ticket?: Ticket,
): Promise<StoredMessage[]> {
  const { rows } = await readThread(boardId, ticketId, { ticket, order: 'asc' });
  return rows;
}

/**
 * One message by id. Inline first (the common case), then pages newest first —
 * an edit, a reaction or a notification preview is nearly always about
 * something recent.
 */
export async function getMessage(
  boardId: string,
  ticketId: string,
  messageId: string,
  ticket?: Ticket,
): Promise<StoredMessage | undefined> {
  const t = await ticketOf(boardId, ticketId, ticket);
  if (!t) return undefined;
  const inline = inlineMessages(t).find((m) => m.id === messageId);
  if (inline) return inline;
  for (let n = (t.pageCount ?? 0) - 1; n >= 0; n--) {
    const p = await loadPage(boardId, ticketId, n);
    const hit = p?.messages.find((m) => m.id === messageId);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The newest `n` messages (oldest first) and the pinned ones — what an agent
 * gets with a ticket and what a digest quotes. Pins stay inline by design
 * (tickets/doc.ts mustStayInline), so both come out of the one document.
 */
export async function recentAndPinned(
  boardId: string,
  ticketId: string,
  n = 20,
  ticket?: Ticket,
): Promise<{ recent: StoredMessage[]; pinned: StoredMessage[] }> {
  const t = await ticketOf(boardId, ticketId, ticket);
  if (!t) return { recent: [], pinned: [] };
  const inline = inlineMessages(t);
  const recent = inline.slice(Math.max(0, inline.length - n));
  return { recent, pinned: pinnedMessages(t) };
}

/** Pinned, newest pin first — the thread's pinned strip. */
export function pinnedMessages(t: Ticket): StoredMessage[] {
  return inlineMessages(t)
    .filter((m) => m.pinnedAt !== null && m.deletedAt === null)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
}

/** Every question message on the ticket, oldest first. */
export function questionMessages(t: Ticket): StoredMessage[] {
  return inlineMessages(t).filter((m) => m.kind === 'question' && m.question);
}

/** The open ones, oldest first (the expiry sweep). */
export function openQuestions(t: Ticket, now: number): StoredMessage[] {
  return questionMessages(t).filter((m) => isOpenQuestion(m, now));
}

/** Activity rows, newest first by default (the History tab). */
export async function readActivity(
  boardId: string,
  ticketId: string,
  q: { ticket?: Ticket; limit?: number; order?: 'asc' | 'desc' } = {},
): Promise<StoredActivity[]> {
  const t = await ticketOf(boardId, ticketId, q.ticket);
  if (!t) return [];
  const limit = q.limit ?? Number.MAX_SAFE_INTEGER;
  const order = q.order ?? 'desc';
  const rows: StoredActivity[] = [];
  const inline = inlineActivity(t);
  if (order === 'desc') {
    rows.push(...[...inline].reverse());
    for (let n = (t.pageCount ?? 0) - 1; n >= 0 && rows.length < limit; n--) {
      const p = await loadPage(boardId, ticketId, n);
      if (p) rows.push(...[...p.activity].reverse());
    }
  } else {
    for (let n = 0; n < (t.pageCount ?? 0) && rows.length < limit; n++) {
      const p = await loadPage(boardId, ticketId, n);
      if (p) rows.push(...p.activity);
    }
    rows.push(...inline);
  }
  return rows.slice(0, limit === Number.MAX_SAFE_INTEGER ? rows.length : limit);
}

/** Every file row on the ticket, oldest first; `live` drops the tombstones. */
export async function readFiles(
  boardId: string,
  ticketId: string,
  opts: { ticket?: Ticket; live?: boolean } = {},
): Promise<TicketFile[]> {
  const t = await ticketOf(boardId, ticketId, opts.ticket);
  if (!t) return [];
  const rows = inlineFiles(t);
  return opts.live === false ? rows : rows.filter((f) => f.deletedAt === null);
}

/** One file row by id (live or tombstoned). */
export async function getFile(
  boardId: string,
  ticketId: string,
  fileId: string,
  ticket?: Ticket,
): Promise<TicketFile | undefined> {
  const t = await ticketOf(boardId, ticketId, ticket);
  return t ? inlineFiles(t).find((f) => f.id === fileId) : undefined;
}

/** Every task list on the ticket, in `position` order (§L2). */
export async function readTasklists(
  boardId: string,
  ticketId: string,
  ticket?: Ticket,
): Promise<StoredTasklist[]> {
  const t = await ticketOf(boardId, ticketId, ticket);
  return t ? inlineTasklists(t) : [];
}

export async function getTasklist(
  boardId: string,
  ticketId: string,
  listId: string,
  ticket?: Ticket,
): Promise<StoredTasklist | undefined> {
  return (await readTasklists(boardId, ticketId, ticket)).find((l) => l.id === listId);
}

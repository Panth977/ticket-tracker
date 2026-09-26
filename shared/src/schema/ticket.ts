/**
 * THE TICKET DOCUMENT — one document per ticket (docs/plan/agents.html §W).
 *
 * Phase 15 folded the ticket's four subcollections into the ticket itself.
 * Firestore bills per document RETURNED, and the old shape fanned a board
 * open out into a dozen listeners plus one unread query PER CARD; the win
 * here is the fan-in, not compression.
 *
 *   boards/{b}/tickets/{t}            ← the fields, the rollup `signals`,
 *                                       `tasklists`, `files`,
 *                                       `recentMessages`, `recentActivity`
 *   boards/{b}/tickets/{t}/data/{NNN} ← older messages / activity, frozen
 *
 * WHAT BELONGS INLINE
 *   · every ticket field, as before;
 *   · `signals` — everything a board card shows without opening the ticket
 *     (message count, last message, open question, task-list progress, file
 *     count, blocked). Derived and server-written; never the source of truth;
 *   · `tasklists` — whole lists, items and all. A list is small and is read
 *     with the card ('4/7'), so it costs nothing to carry;
 *   · `files` — every file row ever put on the ticket, tombstones included.
 *     The Files tab is part of the ticket, not a second query;
 *   · `recentMessages` / `recentActivity` — the newest ones, so opening a
 *     ticket is free. Cut by BOTH a count (KEEP_INLINE_*) and a byte budget
 *     (INLINE_CUT_BYTES ≈ 700 KB of the 1 MB document limit), so a write
 *     always fits.
 *
 * WHAT SPILLS
 *   Older messages and activity, in creation order, into data/{NNN} — 000,
 *   001, … — each page frozen once written and fetched only when someone
 *   scrolls back. `pageCount` says how many there are and `oldestInlineAt`
 *   where the inline window starts, so a reader knows whether it must page.
 *
 * ALL WRITES GO THROUGH THE COMMAND LAYER. A ticket doc takes about one write
 * a second, which is why liveness (heartbeats, typing, presence) lives in the
 * Realtime Database instead (§W3) — never add a per-second field here.
 */
import { z } from 'zod';
import {
  BoardIdSchema,
  FieldValueSchema,
  MillisSchema,
  RichTextSchema,
  StageCategorySchema,
  TicketIdSchema,
  TicketKeySchema,
  TicketLinkSchema,
  TicketStateSchema,
  PrincipalIdSchema,
  UidSchema,
  ViaSchema,
} from '../types/index.js';
import { StoredTasklistSchema, tasklistProgress, type StoredTasklist } from './tasklist.js';
import { questionIsOpen } from './question.js';
import {
  CostCounterSchema,
  StoredActivitySchema,
  StoredMessageSchema,
  TicketFileSchema,
  type StoredActivity,
  type StoredMessage,
  type TicketFile,
} from './message.js';

// Messages, activity and file rows are the same shapes they always were.
export * from './message.js';

// ─── how big the inline window is ────────────────────────────────────────────

/**
 * A page is cut at ~700 KB of the 1 MB document limit so a write always fits:
 * the check runs BEFORE the write, on the serialised size, and one more
 * message (or one edit that grows a body) must never be what pushes it over.
 */
export const INLINE_CUT_BYTES = 700_000;
/** The same budget for one frozen data page. */
export const PAGE_CUT_BYTES = 700_000;
/** Spill when the inline thread is longer than this… */
export const MAX_INLINE_MESSAGES = 200;
/** …down to this. Hysteresis: one page per ~100 messages, not one per message. */
export const KEEP_INLINE_MESSAGES = 100;
export const MAX_INLINE_ACTIVITY = 200;
export const KEEP_INLINE_ACTIVITY = 100;
/* A page's id is `pageId(n)` from ../paths.ts — '000', '001', … */

/**
 * Phase 3 (§L1) — the ticket-level summary of the blocking questions still
 * open on a ticket: what the '❓ Waiting for you' badge on the card, the
 * drawer header and My work read. It names the OLDEST open blocking question,
 * because that is the one the badge links to.
 */
export const WaitingOnSchema = z.object({
  /** How many blocking questions are open right now (the badge shows one). */
  count: z.number().int().nonnegative(),
  messageId: z.string().min(1),
  title: z.string(),
  /** Who may answer; null = anyone on the board who may comment. */
  to: z.array(PrincipalIdSchema).nullable(),
  askedBy: PrincipalIdSchema.nullable(),
  askedAt: MillisSchema,
  expiresAt: MillisSchema.nullable(),
});
export type WaitingOn = z.infer<typeof WaitingOnSchema>;

/**
 * §W — THE ROLLUP A CARD RENDERS FROM. Every one of these is derived from
 * something else in the document and rewritten by the command that changed
 * it, in the same write. A card never queries.
 */
export const TicketSignalsSchema = z.object({
  /** Every message ever posted, spilled ones included (= counts.messages). */
  messageCount: z.number().int().nonnegative(),
  lastMessageAt: MillisSchema.nullable(),
  lastActivityAt: MillisSchema,
  /**
   * The oldest INLINE message's createdAt (null when the thread is empty).
   * '§W2 — unread with no query': the card counts the inline messages newer
   * than its read pointer. A pointer older than this can only be read as
   * 'more than that', which is what the badge already shows.
   */
  unreadFrom: MillisSchema.nullable(),
  /** The oldest open BLOCKING question — the same one `waitingOn` names. */
  question: z
    .object({
      count: z.number().int().nonnegative(),
      to: z.array(PrincipalIdSchema).nullable(),
      title: z.string(),
      expiresAt: MillisSchema.nullable(),
    })
    .nullable(),
  /** Summed over every list on the ticket; `working` is the item with the spinner. */
  tasklist: z
    .object({
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      working: z.string().nullable(),
    })
    .nullable(),
  /** Live files only (tombstones excluded) — the number on the Files tab. */
  fileCount: z.number().int().nonnegative(),
  /** A blocking question is waiting, or another ticket blocks this one. */
  blocked: z.boolean(),
});
export type TicketSignals = z.infer<typeof TicketSignalsSchema>;

/**
 * boards/{boardId}/tickets/{ticketId} — see the header for what is inline and
 * what spills. ALL WRITES GO THROUGH THE COMMAND LAYER.
 *
 * The §W fields are OPTIONAL in the schema and always written by the command
 * layer: a ticket created before phase 15 is still a valid ticket until
 * scripts/migrate-ticket-doc.mjs folds its subcollections in.
 */
export const TicketSchema = z.object({
  /** 'ENG-42' — allocated once and never reissued. */
  key: TicketKeySchema,
  number: z.number().int().positive(),
  title: z.string().min(1).max(500),
  description: RichTextSchema.nullable(),

  stageId: z.string().min(1),
  /** Denormalised so My Work can query 'not done'. */
  stageCategory: StageCategorySchema,
  priorityId: z.string().nullable(),
  tagIds: z.array(z.string()),
  state: TicketStateSchema,
  /** Fractional index — order inside a column. */
  rank: z.string().min(1),

  /** Any member with a role on this board — people AND agents (principal ids). */
  assigneeUids: z.array(PrincipalIdSchema),
  /** Creator + assignees + anyone who opted in. */
  watcherUids: z.array(PrincipalIdSchema),
  /** Intake has no uid. */
  reporter: z.object({ uid: UidSchema.nullable(), name: z.string(), email: z.string().optional() }),

  startAt: MillisSchema.nullable(),
  dueAt: MillisSchema.nullable(),
  dueAllDay: z.boolean(),
  /** Reference 'pickup dates': per person. */
  commitments: z.record(UidSchema, MillisSchema),
  /**
   * Derived, server-written: the earliest commitment deadlineSweep has not
   * nudged yet (null = none pending). Makes commitments queryable, so a
   * ticket with no due date still gets its nudge.
   */
  nextCommitmentAt: MillisSchema.nullable().optional(),
  /** Points or hours, board decides. */
  estimate: z.number().nonnegative().nullable(),

  /** FieldDef.id → value */
  fields: z.record(z.string(), FieldValueSchema),

  /** #tickets this one mentions (description + messages). */
  refs: z.array(TicketIdSchema),
  /** Tickets that #mention THIS one — the backlink, written in the same transaction. */
  referencedBy: z.array(TicketIdSchema),
  /** Written on BOTH tickets by ticketUpdate (blocks ↔ blockedBy). */
  links: z.array(TicketLinkSchema),

  counts: z.object({
    messages: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    pinned: z.number().int().nonnegative(),
  }),
  lastMessageAt: MillisSchema.nullable(),
  lastActivityAt: MillisSchema,
  /** PER PERSON: each has their own lead time. */
  dueNotified: z.record(
    UidSchema,
    z.object({ soon: MillisSchema.optional(), overdue: MillisSchema.optional() }),
  ),

  /** Principal: an agent's token creates tickets as the agent. */
  createdBy: PrincipalIdSchema,
  createdVia: ViaSchema,
  createdAt: MillisSchema,
  updatedAt: MillisSchema,
  /** Set when stageCategory becomes 'done'. */
  completedAt: MillisSchema.nullable(),

  /**
   * Phase 3 (§L1 · §L2) — THE TWO CARD SUMMARIES, derived and server-written.
   * Kept beside `signals` (which repeats them in §W's shape) because the app,
   * the API and My work have read them by these names since phase 3.
   */
  waitingOn: WaitingOnSchema.nullable().optional(),
  tasklistProgress: z
    .object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
    .nullable()
    .optional(),

  // ── phase 15 (§W): the thread, inline ──────────────────────────────────────

  /** Everything a card shows without a second read. */
  signals: TicketSignalsSchema.optional(),
  /** Whole task lists (§L2), in `position` order. */
  tasklists: z.array(StoredTasklistSchema).optional(),
  /** Every file row on the ticket, oldest first, tombstones included. */
  files: z.array(TicketFileSchema).optional(),
  /**
   * The ids of the LIVE files, flat — the one thing a file lookup by id needs
   * (GET /v1/files/{fileId}) now that there is no files/ collection group:
   * collectionGroup('tickets').where('fileIds', 'array-contains', fileId).
   */
  fileIds: z.array(z.string()).optional(),
  /** The newest messages, oldest first. Older ones are in data/{NNN}. */
  recentMessages: z.array(StoredMessageSchema).optional(),
  /** The newest activity rows, oldest first. */
  recentActivity: z.array(StoredActivitySchema).optional(),
  /** How many data/{NNN} pages exist (ids 000 … pageCount-1). */
  pageCount: z.number().int().nonnegative().optional(),
  /**
   * Phase 17 (§Y2): what the agents' turns on this ticket have cost, summed
   * over every receipt ever posted (spilled ones included). A COUNTER kept by
   * messagePost, not a signal: signals are recomputed from the document and
   * the receipts in data pages are not in the document. Absent = nothing yet.
   */
  cost: CostCounterSchema.optional(),
  /** createdAt of the oldest INLINE message or activity row; null when none. */
  oldestInlineAt: MillisSchema.nullable().optional(),
  /**
   * The earliest `expiresAt` among the ticket's OPEN questions, blocking or
   * not (null = none). The only reason it is a top-level field: the expiry
   * sweep has to FIND these tickets, and a query cannot reach into an array —
   * collectionGroup('tickets').where('nextQuestionExpiresAt', '>', 0)
   *                          .where('nextQuestionExpiresAt', '<=', now).
   */
  nextQuestionExpiresAt: MillisSchema.nullable().optional(),
});
export type Ticket = z.infer<typeof TicketSchema>;
/** A ticket with its ids, as commands and views see it (ids come from the path). */
export type TicketWithId = Ticket & { id: string; boardId: string };

/**
 * boards/{b}/tickets/{t}/data/{NNN} — a FROZEN chunk of older messages and
 * activity, oldest first. Written once, when a ticket write would have pushed
 * the document over INLINE_CUT_BYTES, in the SAME transaction as that write;
 * afterwards only an edit of a message inside it ever touches it again
 * (editing a five-year-old comment is allowed; appending to a closed page is
 * not). Read only when someone scrolls back past `oldestInlineAt`.
 */
export const TicketDataPageSchema = z.object({
  /** Its own number, = the doc id as an integer. */
  page: z.number().int().nonnegative(),
  messages: z.array(StoredMessageSchema),
  activity: z.array(StoredActivitySchema),
  /** createdAt of the first and last row in the page — lets a reader skip it. */
  from: MillisSchema,
  to: MillisSchema,
  createdAt: MillisSchema,
});
export type TicketDataPage = z.infer<typeof TicketDataPageSchema>;

/**
 * keys/{ticketKey} — '#ENG-42' → the ticket it names. A key is allocated once
 * and never reissued: on delete the row is KEPT with deleted: true, so an old
 * link says 'this ticket is gone' instead of landing on somebody else's work.
 */
export const KeyIndexSchema = z.object({
  ticketId: TicketIdSchema,
  boardId: BoardIdSchema,
  /** The key itself — equal to the doc id. */
  current: TicketKeySchema,
  deleted: z.boolean().optional(),
});
export type KeyIndex = z.infer<typeof KeyIndexSchema>;

// ─── the inline window, and the spill ────────────────────────────────────────
//
// PURE — shared by the command layer (backend/src/tickets/doc.ts) and by
// scripts/migrate-ticket-doc.mjs, so the fold a migration writes and the fold
// a write produces are the same fold.

/** Newest last. The order every inline array and every data page is kept in. */
export const byTime = <T extends { createdAt: number; id: string }>(a: T, b: T): number =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Serialised size in BYTES — the number the cut is measured against. UTF-8
 * counted by hand rather than through TextEncoder / Buffer, because this runs
 * in the browser, in the functions and in a plain `node` migration script.
 */
export function docBytes(v: unknown): number {
  const s = JSON.stringify(v ?? null);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4; // a surrogate pair is one 4-byte code point
      i++;
    } else n += 3;
  }
  return n;
}

export const inlineMessages = (t: Pick<Ticket, 'recentMessages'>): StoredMessage[] =>
  [...(t.recentMessages ?? [])].sort(byTime);

export const inlineActivity = (t: Pick<Ticket, 'recentActivity'>): StoredActivity[] =>
  [...(t.recentActivity ?? [])].sort(byTime);

export const inlineTasklists = (t: Pick<Ticket, 'tasklists'>): StoredTasklist[] =>
  [...(t.tasklists ?? [])].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);

export const inlineFiles = (t: Pick<Ticket, 'files'>): TicketFile[] =>
  [...(t.files ?? [])].sort((a, b) => a.createdAt - b.createdAt);

/** A question that is still waiting for an answer. */
export const isOpenQuestion = (
  m: Pick<StoredMessage, 'kind' | 'question' | 'deletedAt'>,
  now: number,
): boolean =>
  m.kind === 'question' && !!m.question && m.deletedAt === null && questionIsOpen(m.question, now);

/**
 * A message the inline window KEEPS even when the thread is long enough to
 * spill: an open question (the card's '❓ Waiting for you' and the expiry
 * sweep read it from here) and a pinned message (pins are decisions; the API
 * answers `pinned_messages` from the inline window). Both are few and both
 * are exactly what someone opening the ticket needs first.
 *
 * It only ever LIMITS how much of the oldest run is evicted — the inline
 * window stays a contiguous newest run, so page 000 … page N-1 followed by
 * the inline array is the thread in order. Under real byte pressure the pin
 * is ignored rather than letting the document approach the 1 MB limit.
 */
export const mustStayInline = (m: StoredMessage, now: number): boolean =>
  m.pinnedAt !== null || isOpenQuestion(m, now);

export interface PagePlan {
  page: number;
  doc: TicketDataPage;
}

export interface SpillPlan {
  messages: StoredMessage[];
  activity: StoredActivity[];
  pages: PagePlan[];
}

/** Split an evicted run into pages of at most PAGE_CUT_BYTES, in order. */
export function toPages(
  messages: readonly StoredMessage[],
  activity: readonly StoredActivity[],
  startPage: number,
  now: number,
): PagePlan[] {
  const out: PagePlan[] = [];
  let cur: { messages: StoredMessage[]; activity: StoredActivity[]; size: number } = {
    messages: [],
    activity: [],
    size: 0,
  };
  const flush = () => {
    if (!cur.messages.length && !cur.activity.length) return;
    const stamps = [...cur.messages, ...cur.activity].map((r) => r.createdAt);
    const page = startPage + out.length;
    out.push({
      page,
      doc: {
        page,
        messages: cur.messages,
        activity: cur.activity,
        from: Math.min(...stamps),
        to: Math.max(...stamps),
        createdAt: now,
      },
    });
    cur = { messages: [], activity: [], size: 0 };
  };
  for (const m of messages) {
    const b = docBytes(m);
    if (cur.size + b > PAGE_CUT_BYTES && cur.messages.length) flush();
    cur.messages.push(m);
    cur.size += b;
  }
  for (const a of activity) {
    const b = docBytes(a);
    if (cur.size + b > PAGE_CUT_BYTES && (cur.messages.length || cur.activity.length)) flush();
    cur.activity.push(a);
    cur.size += b;
  }
  flush();
  return out;
}

/**
 * Decide what stays inline. `fixedBytes` is everything on the document that is
 * NOT the two inline arrays, so the budget is the whole document's.
 *
 * The cut is ~700 KB of Firestore's 1 MB, checked BEFORE the write: one more
 * message must never be what makes a document unwritable.
 */
export function planSpill(
  messages: readonly StoredMessage[],
  activity: readonly StoredActivity[],
  fixedBytes: number,
  firstPage: number,
  now: number,
): SpillPlan {
  let msgs = [...messages];
  let acts = [...activity];
  const pages: PagePlan[] = [];
  let next = firstPage;

  for (let guard = 0; guard < 10_000; guard++) {
    const overCount = msgs.length > MAX_INLINE_MESSAGES || acts.length > MAX_INLINE_ACTIVITY;
    const overBytes = fixedBytes + docBytes(msgs) + docBytes(acts) > INLINE_CUT_BYTES;
    if (!overCount && !overBytes) break;
    if (msgs.length + acts.length <= 1) break; // nothing left to move

    let takeM = msgs.length > MAX_INLINE_MESSAGES ? msgs.length - KEEP_INLINE_MESSAGES : 0;
    let takeA = acts.length > MAX_INLINE_ACTIVITY ? acts.length - KEEP_INLINE_ACTIVITY : 0;
    if (!takeM && !takeA) {
      // Byte pressure alone: halve both, so one huge message cannot loop.
      takeM = Math.ceil(msgs.length / 2);
      takeA = Math.ceil(acts.length / 2);
    }
    // Keep pins and open questions inline — unless bytes leave no choice.
    if (!overBytes) {
      const firstKept = msgs.findIndex((m) => mustStayInline(m, now));
      if (firstKept >= 0) takeM = Math.min(takeM, firstKept);
    }
    if (!takeM && !takeA) break;

    const made = toPages(msgs.slice(0, takeM), acts.slice(0, takeA), next, now);
    msgs = msgs.slice(takeM);
    acts = acts.slice(takeA);
    pages.push(...made);
    next += made.length;
  }
  return { messages: msgs, activity: acts, pages };
}

export interface QuestionRollup {
  waitingOn: WaitingOn | null;
  /** The earliest expiry among OPEN questions, blocking or not. */
  nextQuestionExpiresAt: number | null;
}

/**
 * `waitingOn` (§L1) and `nextQuestionExpiresAt` from the inline thread.
 *
 * `carry` is the ticket's current waitingOn: when it names a question that is
 * no longer inline (it spilled while still open — only possible under real
 * byte pressure) it is kept, because the row itself holds everything the badge
 * shows and losing it would silently un-block the ticket.
 */
export function questionRollup(
  messages: readonly StoredMessage[],
  now: number,
  carry: WaitingOn | null,
): QuestionRollup {
  const open = messages.filter((m) => isOpenQuestion(m, now));
  const spilled = !!carry && !messages.some((m) => m.id === carry.messageId);
  const blocking: WaitingOn[] = open
    .filter((m) => m.question!.blocking)
    .map((m) => ({
      count: 1,
      messageId: m.id,
      title: m.question!.title,
      to: m.question!.to ?? null,
      askedBy: m.authorUid,
      askedAt: m.createdAt,
      expiresAt: m.question!.expiresAt,
    }));
  if (spilled) blocking.push({ ...carry!, count: 1 });
  blocking.sort((a, b) => a.askedAt - b.askedAt);
  // The expiry sweep looks for questions the CLOCK has passed but the
  // document still calls 'open', so this follows the stored status rather
  // than isOpenQuestion (which already reads an overdue one as expired).
  const expiries = [
    ...messages
      .filter((m) => m.kind === 'question' && m.deletedAt === null && m.question?.status === 'open')
      .map((m) => m.question!.expiresAt),
    ...(spilled ? [carry!.expiresAt] : []),
  ].filter((e): e is number => typeof e === 'number');
  return {
    waitingOn: blocking.length ? { ...blocking[0]!, count: blocking.length } : null,
    nextQuestionExpiresAt: expiries.length ? Math.min(...expiries) : null,
  };
}

/** The '4/7' chip and the item with the spinner, summed over every list (§L2). */
export function tasklistRollup(
  lists: readonly StoredTasklist[],
): { done: number; total: number; working: string | null } | null {
  if (!lists.length) return null;
  let done = 0;
  let total = 0;
  let working: string | null = null;
  for (const list of lists) {
    const p = tasklistProgress(list);
    done += p.settled;
    total += p.total;
    if (!working && p.current) working = p.current.title;
  }
  return total === 0 ? null : { done, total, working };
}

/**
 * §W's card rollup, derived from the document itself — never a second source
 * of truth. Everything here is readable from the snapshot a board list
 * already has, which is what makes the per-card unread listener disappear.
 */
export function signalsOf(t: Ticket): TicketSignals {
  const msgs = inlineMessages(t);
  const lists = inlineTasklists(t);
  const live = inlineFiles(t).filter((f) => f.deletedAt === null);
  return {
    messageCount: t.counts.messages,
    lastMessageAt: t.lastMessageAt,
    lastActivityAt: t.lastActivityAt,
    unreadFrom: msgs.length ? msgs[0]!.createdAt : null,
    question: t.waitingOn
      ? {
          count: t.waitingOn.count,
          to: t.waitingOn.to,
          title: t.waitingOn.title,
          expiresAt: t.waitingOn.expiresAt,
        }
      : null,
    tasklist: tasklistRollup(lists),
    fileCount: live.length,
    // A person is waiting on a blocking question, or another ticket blocks this one.
    blocked: !!t.waitingOn || t.links.some((l) => l.type === 'blockedBy'),
  };
}

export const oldestOf = (
  msgs: readonly { createdAt: number }[],
  acts: readonly { createdAt: number }[],
): number | null => {
  const all = [...msgs, ...acts].map((r) => r.createdAt);
  return all.length ? Math.min(...all) : null;
};

/**
 * A ticket with its §W fields filled in from the rows given: used by
 * ticketCreate (which writes a whole document) and by the migration, which
 * folds four subcollections into one.
 */
export function withInline(
  t: Ticket,
  inline: {
    messages?: StoredMessage[];
    activity?: StoredActivity[];
    files?: TicketFile[];
    tasklists?: StoredTasklist[];
  } = {},
): Ticket {
  const msgs = [...(inline.messages ?? [])].sort(byTime);
  const acts = [...(inline.activity ?? [])].sort(byTime);
  const files = inline.files ?? [];
  const base: Ticket = {
    ...t,
    tasklists: inline.tasklists ?? [],
    files,
    fileIds: files.filter((f) => f.deletedAt === null).map((f) => f.id),
    recentMessages: msgs,
    recentActivity: acts,
    pageCount: 0,
    oldestInlineAt: oldestOf(msgs, acts),
    nextQuestionExpiresAt: t.nextQuestionExpiresAt ?? null,
  };
  return { ...base, signals: signalsOf(base) };
}

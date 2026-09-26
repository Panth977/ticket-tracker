/**
 * THE TICKET DOCUMENT, WRITE SIDE (docs/plan/agents.html §W).
 *
 * A ticket is ONE document: its fields, its rollup `signals`, its task lists,
 * its files, its recent messages and its recent activity. Older messages and
 * activity spill forward into boards/{b}/tickets/{t}/data/{NNN}. Everything a
 * command used to write as three or four documents it now writes as one.
 *
 *   const w = await openTicket(tx, ctx, boardId, ticketId);   // the read phase
 *   w.addMessage(id, message);
 *   w.addActivity(id, activityDoc(ctx, 'update', changes));
 *   w.commit();                                               // ONE tx.update
 *
 * WHY A CLASS AND NOT A PATCH BUILDER: the inline arrays are rewritten whole,
 * so every writer needs the document as it stands — which it has anyway,
 * because every ticket command already reads the ticket in its transaction.
 * The spill decision needs the same thing (the serialised size AFTER this
 * write), so it can only be made here, at commit time, in the same
 * transaction: 'a write that would push the doc over the cut moves the oldest
 * inline chunk into the next page'.
 *
 * FIRESTORE ORDERS READS BEFORE WRITES. Everything async on this class
 * (openTicket, locateMessage, loadPage) belongs to the read phase; the rest is
 * synchronous staging and commit() is the only write.
 */
import { type Transaction, type WriteBatch } from 'firebase-admin/firestore';
import {
  byTime,
  docBytes,
  errors,
  inlineActivity,
  inlineFiles,
  inlineMessages,
  inlineTasklists,
  isOpenQuestion,
  oldestOf,
  paths,
  planSpill,
  questionRollup,
  signalsOf,
  tasklistRollup,
  withInline,
  type Activity,
  type Message,
  type QuestionRollup,
  type StoredActivity,
  type StoredMessage,
  type StoredTasklist,
  type Ticket,
  type TicketDataPage,
  type TicketFile,
  type WaitingOn,
} from '@tm/shared';
import { typedDoc } from '../runtime/converters.js';
import type { ServerCtx } from '../runtime/context.js';
import { txGet, type Tx } from '../runtime/tx.js';
import { ticketRef } from './access.js';
import { updateArgs, type Pair } from './patch.js';

// ─── the document, as the inline arrays ──────────────────────────────────────
//
// The arithmetic — what stays inline, what spills, what the signals say — is
// PURE and lives in @tm/shared (schema/ticket.ts), so the fold a write
// produces and the fold scripts/migrate-ticket-doc.mjs writes are the same
// fold. Everything below is the Firestore side of it.

export const pageRef = (boardId: string, ticketId: string, page: number) =>
  typedDoc('ticketData', paths.ticketPage(boardId, ticketId, page));

export {
  inlineActivity,
  inlineFiles,
  inlineMessages,
  inlineTasklists,
  isOpenQuestion,
  planSpill,
  questionRollup,
  signalsOf,
  tasklistRollup,
  withInline,
};

// ─── the writer ──────────────────────────────────────────────────────────────

/** Where a message was found (a patch has to write it back to the same place). */
export type MessageHome = { where: 'inline' } | { where: 'page'; page: number };

export interface FoundMessage {
  id: string;
  message: StoredMessage;
  home: MessageHome;
}

/**
 * One ticket document, staged. Created by openTicket() inside a transaction;
 * commit() writes the ticket (and the pages a spill made, and any page an
 * edit touched) and nothing else.
 */
export class TicketWriter {
  /** The ticket as it was READ. Never mutated — commands diff against it. */
  readonly before: Ticket;

  private msgs: StoredMessage[];
  private acts: StoredActivity[];
  private lists: StoredTasklist[];
  private fileRows: TicketFile[];
  private counts: Ticket['counts'];
  private lastMessageAt: number | null;
  private lastActivityAt: number;
  private waitingCarry: WaitingOn | null;
  /** Field path (joined) → the value to write. Later wins, so a caller's own
   *  value for a computed field replaces it instead of colliding with it. */
  private fields = new Map<string, Pair>();
  private pages = new Map<number, TicketDataPage>();
  /** Pages whose contents this transaction changed (an edit of an old message). */
  private editedPages = new Set<number>();
  private dirty = false;

  /**
   * `w` is where the writes go (a transaction, or a batch for ticketBulk);
   * `rtx` is the transaction reads may use — null for a batch, which has
   * already read everything it needs and never pages.
   */
  constructor(
    private readonly w: Transaction | WriteBatch,
    private readonly rtx: Tx | null,
    private readonly ctx: Pick<ServerCtx, 'now' | 'ids'>,
    readonly boardId: string,
    readonly ticketId: string,
    ticket: Ticket,
  ) {
    this.before = ticket;
    this.msgs = inlineMessages(ticket);
    this.acts = inlineActivity(ticket);
    this.lists = inlineTasklists(ticket);
    this.fileRows = inlineFiles(ticket);
    this.counts = { ...ticket.counts };
    this.lastMessageAt = ticket.lastMessageAt;
    this.lastActivityAt = ticket.lastActivityAt;
    this.waitingCarry = ticket.waitingOn ?? null;
  }

  private ref() {
    return ticketRef(this.boardId, this.ticketId);
  }

  // ── the thread ────────────────────────────────────────────────────────────

  /** An inline message by id (the common case: it was posted recently). */
  find(messageId: string): StoredMessage | undefined {
    return this.msgs.find((m) => m.id === messageId);
  }

  /**
   * A message anywhere on the ticket: inline, else in a data page — newest
   * page first, because an edit is nearly always of something recent. READ
   * PHASE: it may fetch pages, so call it before the first staging call.
   */
  async locate(messageId: string): Promise<FoundMessage | null> {
    const inline = this.find(messageId);
    if (inline) return { id: messageId, message: inline, home: { where: 'inline' } };
    const count = this.before.pageCount ?? 0;
    for (let n = count - 1; n >= 0; n--) {
      const page = await this.page(n);
      const hit = page?.messages.find((m) => m.id === messageId);
      if (hit) return { id: messageId, message: hit, home: { where: 'page', page: n } };
    }
    return null;
  }

  /** A data page, read once per transaction and remembered. */
  async page(n: number): Promise<TicketDataPage | undefined> {
    const held = this.pages.get(n);
    if (held) return held;
    if (!this.rtx) throw new Error('page(): this writer has no transaction to read with');
    const doc = await txGet(this.rtx, pageRef(this.boardId, this.ticketId, n));
    if (doc) this.pages.set(n, doc);
    return doc;
  }

  /**
   * Append a message. A system line ('Priya archived this ticket') counts in
   * counts.messages but does NOT move lastMessageAt — a state change is not a
   * reason to mark the thread unread for everyone.
   */
  addMessage(messageId: string, message: Message): StoredMessage {
    const row: StoredMessage = { ...message, id: messageId };
    this.msgs = [...this.msgs, row].sort(byTime);
    this.counts.messages += 1;
    if (message.kind !== 'system') this.lastMessageAt = message.createdAt;
    this.lastActivityAt = Math.max(this.lastActivityAt, message.createdAt);
    if (message.pinnedAt !== null) this.counts.pinned += 1;
    this.dirty = true;
    return row;
  }

  /** Change one message in place, wherever it lives (see locate()). */
  patchMessage(found: FoundMessage, patch: Partial<Message>): StoredMessage {
    const next: StoredMessage = { ...found.message, ...patch, id: found.id };
    const wasPinned = found.message.pinnedAt !== null;
    const isPinned = next.pinnedAt !== null;
    if (wasPinned !== isPinned) this.counts.pinned += isPinned ? 1 : -1;
    if (found.home.where === 'inline') {
      this.msgs = this.msgs.map((m) => (m.id === found.id ? next : m));
    } else {
      const page = this.pages.get(found.home.page);
      if (!page) throw new Error(`patchMessage: page ${found.home.page} was not read`);
      this.pages.set(found.home.page, {
        ...page,
        messages: page.messages.map((m) => (m.id === found.id ? next : m)),
      });
      this.editedPages.add(found.home.page);
    }
    this.dirty = true;
    return next;
  }

  /** Every message the ticket carries inline, oldest first (staged state). */
  messages(): readonly StoredMessage[] {
    return this.msgs;
  }

  addActivity(activity: Activity, id?: string): void {
    this.acts = [...this.acts, { ...activity, id: id ?? this.ctx.ids.id() }].sort(byTime);
    this.lastActivityAt = Math.max(this.lastActivityAt, activity.createdAt);
    this.dirty = true;
  }

  // ── task lists ────────────────────────────────────────────────────────────

  tasklists(): readonly StoredTasklist[] {
    return this.lists;
  }

  tasklist(listId: string): StoredTasklist | undefined {
    return this.lists.find((l) => l.id === listId);
  }

  setTasklist(list: StoredTasklist): void {
    this.lists = [...this.lists.filter((l) => l.id !== list.id), list].sort(
      (a, b) => a.position - b.position || a.createdAt - b.createdAt,
    );
    this.dirty = true;
  }

  removeTasklist(listId: string): void {
    this.lists = this.lists.filter((l) => l.id !== listId);
    this.dirty = true;
  }

  // ── files ─────────────────────────────────────────────────────────────────

  files(): readonly TicketFile[] {
    return this.fileRows;
  }

  file(fileId: string): TicketFile | undefined {
    return this.fileRows.find((f) => f.id === fileId);
  }

  addFiles(rows: readonly TicketFile[]): void {
    if (!rows.length) return;
    const ids = new Set(rows.map((r) => r.id));
    this.fileRows = [...this.fileRows.filter((f) => !ids.has(f.id)), ...rows].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    this.dirty = true;
  }

  patchFile(fileId: string, patch: Partial<TicketFile>): void {
    this.fileRows = this.fileRows.map((f) => (f.id === fileId ? { ...f, ...patch } : f));
    this.dirty = true;
  }

  /** Every live file that arrived with one message (a delete tombstones them). */
  filesOfMessage(messageId: string): TicketFile[] {
    return this.fileRows.filter((f) => f.messageId === messageId && f.deletedAt === null);
  }

  // ── plain ticket fields ───────────────────────────────────────────────────

  /** Ordinary top-level fields (title, stageId, refs, links …). */
  set(fields: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(fields)) this.fields.set(k, [[k], v]);
    this.dirty = true;
  }

  /** Field PATHS, for keys that must not be split on '.' (fields.f_abc, uids). */
  setPairs(pairs: readonly Pair[]): void {
    for (const p of pairs) this.fields.set(p[0].join('\u0000'), p);
    if (pairs.length) this.dirty = true;
  }

  /** The plain top-level fields staged so far (for after()/commit()'s view). */
  private plainFields(): Partial<Ticket> {
    const out: Record<string, unknown> = {};
    for (const [path, value] of this.fields.values()) {
      if (path.length === 1) out[path[0]!] = value;
    }
    return out as Partial<Ticket>;
  }

  /** counts.pinned is the only counter a command still moves by hand. */
  bumpPinned(by: number): void {
    this.counts.pinned += by;
    this.dirty = true;
  }

  touch(now = this.ctx.now): void {
    this.lastActivityAt = Math.max(this.lastActivityAt, now);
    this.dirty = true;
  }

  /** The waitingOn / nextQuestionExpiresAt this write leaves behind. */
  rollup(): QuestionRollup {
    return questionRollup(this.msgs, this.ctx.now, this.waitingCarry);
  }

  /**
   * Forget the carried waitingOn row — the command settled THAT question, so
   * a spilled-but-open row must not be resurrected.
   */
  dropCarry(messageId: string): void {
    if (this.waitingCarry?.messageId === messageId) this.waitingCarry = null;
  }

  /** The ticket as it will be after commit() — what after-commit effects use. */
  after(): Ticket {
    const q = this.rollup();
    const base: Ticket = {
      ...this.before,
      ...this.plainFields(),
      counts: {
        ...this.counts,
        files: this.fileRows.filter((f) => f.deletedAt === null).length,
      },
      lastMessageAt: this.lastMessageAt,
      lastActivityAt: this.lastActivityAt,
      waitingOn: q.waitingOn,
      nextQuestionExpiresAt: q.nextQuestionExpiresAt,
      tasklists: this.lists,
      files: this.fileRows,
      fileIds: this.fileRows.filter((f) => f.deletedAt === null).map((f) => f.id),
      recentMessages: this.msgs,
      recentActivity: this.acts,
      pageCount: this.before.pageCount ?? 0,
      oldestInlineAt: oldestOf(this.msgs, this.acts),
      tasklistProgress: (() => {
        const r = tasklistRollup(this.lists);
        return r ? { done: r.done, total: r.total } : null;
      })(),
    };
    return { ...base, signals: signalsOf(base) };
  }

  /**
   * ONE write for the ticket, plus one per page a spill created or an edit
   * touched. Returns the ticket as it now stands.
   */
  commit(): Ticket {
    const q = this.rollup();
    const liveFiles = this.fileRows.filter((f) => f.deletedAt === null);
    const staged: Ticket = {
      ...this.before,
      ...this.plainFields(),
      counts: { ...this.counts, files: liveFiles.length },
      lastMessageAt: this.lastMessageAt,
      lastActivityAt: this.lastActivityAt,
      waitingOn: q.waitingOn,
      nextQuestionExpiresAt: q.nextQuestionExpiresAt,
      tasklists: this.lists,
      files: this.fileRows,
      fileIds: liveFiles.map((f) => f.id),
      recentMessages: this.msgs,
      recentActivity: this.acts,
    };
    // The budget is the WHOLE document's, so weigh everything but the two
    // arrays that can move out of it.
    const fixed = docBytes({ ...staged, recentMessages: [], recentActivity: [] });
    const spill = planSpill(this.msgs, this.acts, fixed, this.before.pageCount ?? 0, this.ctx.now);

    const tasks = tasklistRollup(this.lists);
    const next: Ticket = {
      ...staged,
      recentMessages: spill.messages,
      recentActivity: spill.activity,
      pageCount: (this.before.pageCount ?? 0) + spill.pages.length,
      oldestInlineAt: oldestOf(spill.messages, spill.activity),
      tasklistProgress: tasks ? { done: tasks.done, total: tasks.total } : null,
    };
    const withSignals: Ticket = { ...next, signals: signalsOf(next) };

    // The pages first: a reader that sees the new ticket must find them.
    const w = this.w as Transaction;
    for (const p of spill.pages) {
      w.set(pageRef(this.boardId, this.ticketId, p.page), p.doc);
    }
    for (const [n, doc] of this.pages) {
      // Only pages an edit actually rewrote; a page read for a lookup is left alone.
      if (this.editedPages.has(n)) w.set(pageRef(this.boardId, this.ticketId, n), doc);
    }

    // Computed first, the caller's own fields second: the map dedupes by path,
    // and Firestore rejects a document field specified twice.
    const out = new Map<string, Pair>();
    const put = (path: string[], value: unknown) => out.set(path.join('\u0000'), [path, value]);
    put(['counts'], withSignals.counts);
    put(['lastMessageAt'], withSignals.lastMessageAt);
    put(['lastActivityAt'], withSignals.lastActivityAt);
    put(['waitingOn'], withSignals.waitingOn);
    put(['nextQuestionExpiresAt'], withSignals.nextQuestionExpiresAt);
    put(['tasklistProgress'], withSignals.tasklistProgress);
    put(['tasklists'], withSignals.tasklists);
    put(['files'], withSignals.files);
    put(['fileIds'], withSignals.fileIds);
    put(['recentMessages'], withSignals.recentMessages);
    put(['recentActivity'], withSignals.recentActivity);
    put(['pageCount'], withSignals.pageCount);
    put(['oldestInlineAt'], withSignals.oldestInlineAt);
    put(['signals'], withSignals.signals);
    for (const [k, pair] of this.fields) out.set(k, pair);
    w.update(this.ref(), ...updateArgs([...out.values()]));
    return withSignals;
  }

  /** Did anything at all get staged? (messageReact on an unchanged emoji, …) */
  get touched(): boolean {
    return this.dirty;
  }
}

/**
 * Read a ticket inside a transaction and stage a write on it. 404 when the
 * ticket is gone — the same answer a board you cannot read gives.
 */
export async function openTicket(
  tx: Tx,
  ctx: Pick<ServerCtx, 'now' | 'ids'>,
  boardId: string,
  ticketId: string,
): Promise<TicketWriter> {
  const t = await txGet(tx, ticketRef(boardId, ticketId));
  if (!t) throw errors.not_found('Ticket not found');
  return new TicketWriter(tx, tx, ctx, boardId, ticketId, t);
}

/** A writer over a ticket already read in this transaction (ref targets). */
export function writerFor(
  tx: Tx,
  ctx: Pick<ServerCtx, 'now' | 'ids'>,
  boardId: string,
  ticketId: string,
  ticket: Ticket,
): TicketWriter {
  return new TicketWriter(tx, tx, ctx, boardId, ticketId, ticket);
}

/**
 * A writer that writes into a BATCH (ticketBulk, which reads its tickets up
 * front and then writes hundreds of them). No transaction, so no paging: a
 * bulk action only ever appends.
 */
export function batchWriter(
  batch: WriteBatch,
  ctx: Pick<ServerCtx, 'now' | 'ids'>,
  boardId: string,
  ticketId: string,
  ticket: Ticket,
): TicketWriter {
  return new TicketWriter(batch, null, ctx, boardId, ticketId, ticket);
}

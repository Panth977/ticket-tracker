/**
 * THE PUBLIC TYPES of window.BackendDriver (docs/plan/artifacts.html §E2).
 *
 * THIS FILE HAS NO IMPORTS AND NO RUNTIME CODE, ON PURPOSE: build.mjs ships it
 * verbatim as driver.d.ts, so an artifact's TypeScript project gets types from
 * one URL with nothing to resolve. The shapes that cross postMessage are the
 * ones in @tm/shared/artifacts/driver; src/contract.ts fails the typecheck if
 * the two ever drift apart.
 */

export type ArtifactRole = 'owner' | 'editor' | 'viewer';

/** Who is looking. `readOnly` is true when THIS viewer may not write data. */
export interface Me {
  uid: string;
  name: string | null;
  email: string | null;
  photoURL: string | null;
  role: ArtifactRole;
  readOnly: boolean;
}

export interface ArtifactInfo {
  id: string;
  name: string;
  buildId: string;
}

/** A document as the artifact sees it. `path` is in the artifact's own view ('/my/doc'). */
export interface Doc<T = Record<string, unknown>> {
  id: string;
  path: string;
  exists: boolean;
  data: T | null;
}

export type WhereOp =
  '<' | '<=' | '==' | '!=' | '>=' | '>' | 'array-contains' | 'in' | 'not-in' | 'array-contains-any';

export interface ListQuery {
  where?: [field: string, op: WhereOp, value: unknown][];
  orderBy?: [field: string, dir?: 'asc' | 'desc'];
  /** Default 100, at most 500. */
  limit?: number;
  /** A document id in this collection — the last id of the previous page. */
  startAfter?: string;
}

export type ErrorCode =
  'permission-denied' | 'not-found' | 'invalid-argument' | 'quota' | 'unavailable';

/** Every rejected Promise (and every onError) carries one of these. */
export interface BackendDriverError extends Error {
  code: ErrorCode;
}

/** db.serverTime — becomes the server's timestamp wherever it sits in a written value. */
export interface ServerTime {
  readonly __tm: 'serverTime';
}

export type Unsubscribe = () => void;
export type OnError = (error: BackendDriverError) => void;

export interface FileInfo {
  path: string;
  size: number;
  contentType: string | null;
  /** Milliseconds since the epoch. */
  updatedAt: number;
}

export interface FirestoreApi {
  /** A document path has an even number of segments: '/my/doc'. */
  get<T = Record<string, unknown>>(path: string): Promise<Doc<T>>;
  set(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): Promise<void>;
  /** Fails with not-found when the document does not exist. 'a.b' keys reach into maps. */
  update(path: string, patch: Record<string, unknown>): Promise<void>;
  delete(path: string): Promise<void>;
  /** A collection path has an odd number of segments: '/my'. */
  add(collectionPath: string, data: Record<string, unknown>): Promise<{ id: string; path: string }>;
  list<T = Record<string, unknown>>(collectionPath: string, query?: ListQuery): Promise<Doc<T>[]>;
  onDoc<T = Record<string, unknown>>(
    path: string,
    callback: (doc: Doc<T>) => void,
    onError?: OnError,
  ): Unsubscribe;
  onList<T = Record<string, unknown>>(
    collectionPath: string,
    query: ListQuery | null | undefined,
    callback: (docs: Doc<T>[]) => void,
    onError?: OnError,
  ): Unsubscribe;
}

export interface RtdbApi {
  get<T = unknown>(path: string): Promise<T | null>;
  set(path: string, value: unknown): Promise<void>;
  update(path: string, patch: Record<string, unknown>): Promise<void>;
  push(path: string, value: unknown): Promise<{ key: string; path: string }>;
  remove(path: string): Promise<void>;
  /** Value events: the whole subtree at `path`, now and on every change. */
  on<T = unknown>(
    path: string,
    callback: (value: T | null) => void,
    onError?: OnError,
  ): Unsubscribe;
}

export interface StorageApi {
  upload(
    path: string,
    blob: Blob,
    options?: { contentType?: string },
  ): Promise<{ path: string; size: number }>;
  /** A short-lived URL you can put in <img src>. */
  url(path: string): Promise<string>;
  list(prefix?: string): Promise<FileInfo[]>;
  delete(path: string): Promise<void>;
}

/** Per viewer, per artifact — what localStorage would have been (an artifact has none). */
export interface KvApi {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

// ─── a board's tickets (§K) ──────────────────────────────────────────────────

/** A person or agent on a board. */
export interface Person {
  id: string;
  kind: 'user' | 'agent';
  name: string;
  /** '' for agents. */
  email: string;
}

/** A board the artifact's owner let it use (tickets.boards()). */
export interface Board {
  id: string;
  key: string;
  name: string;
  /** What the owner granted. */
  access: 'read' | 'write';
  /** May THIS viewer change tickets here (a write grant AND their own role on the board)? */
  canWrite: boolean;
  stages: { id: string; name: string; category: string }[];
  priorities: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  fields: { id: string; name: string; type: string; options?: string[] }[];
  members: Person[];
  /** The board's aggregate fields (numbers it adds up — Cost, hours…), archived ones included. */
  aggFields: AggField[];
  /** Lifetime { total, count } per aggregate field id. */
  aggs: Record<string, AggCounter>;
}

/** An aggregate field: a number the board adds up per ticket and per period. */
export interface AggField {
  /** 'cost', or 'a_' + 6 characters. */
  id: string;
  label: string;
  /** '$', 'h', 'pts'… — '' for a plain count. */
  unit: string;
  /** How its buckets are cut: '2026-10-05' · '2026-W40' (ISO week) · '2026-10'. */
  period: 'daily' | 'weekly' | 'monthly';
  /** Removed from the board: history kept, no new entries. */
  archived: boolean;
}

/** A running sum: the entries' total and how many there were. */
export interface AggCounter {
  total: number;
  count: number;
}

/** A ticket: names, not ids; Markdown description; times in millis. */
export interface Ticket {
  id: string;
  key: string;
  /** The board's key. */
  board: string;
  /** Opens the ticket in TaskManager. */
  url: string;
  title: string;
  description: string;
  stage: { id: string; name: string; category: string };
  priority: { id: string; name: string } | null;
  tags: string[];
  assignees: Person[];
  state: 'active' | 'archived';
  startAt: number | null;
  dueAt: number | null;
  /** Custom fields by NAME; select options by name. */
  fields: Record<string, unknown>;
  /** How many messages its thread has. */
  messages: number;
  /** This ticket's { total, count } per aggregate field id. */
  aggs: Record<string, AggCounter>;
  createdAt: number;
  updatedAt: number;
}

/** A file on a message. Its bytes: tickets.fileUrl(key, id). */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** A question card (kind 'question'): the form an agent asked, and the answer once given. */
export interface Question {
  title: string;
  status: 'open' | 'answered' | 'cancelled' | 'expired';
  /** The ticket waits on it ('Waiting for your answer'). */
  blocking: boolean;
  fields: {
    id: string;
    label: string;
    type: 'single' | 'multi' | 'text' | 'longText' | 'number' | 'boolean' | 'date';
    required: boolean;
    /** single / multi: the choices' labels. */
    options?: string[];
  }[];
  /** null until answered. `values` by field LABEL; choices by label, dates in millis. */
  answer: {
    values: Record<string, unknown>;
    comment: string | null;
    by: Person;
    at: number;
  } | null;
}

/** One message of a ticket's thread. */
export interface Message {
  id: string;
  /** comment · system ('Priya moved this to QA') · question (a form card) · agg (entries on aggregate fields). */
  kind: 'comment' | 'system' | 'question' | 'agg';
  /** Who wrote it; for system lines and outsiders (email) the id is ''. */
  author: Person;
  /** Markdown; '' when deleted. */
  markdown: string;
  createdAt: number;
  editedAt: number | null;
  /** A tombstone: 'This message was deleted' — markdown and attachments are empty. */
  deleted: boolean;
  /** The quoted message's id. */
  replyTo: string | null;
  pinned: boolean;
  attachments: Attachment[];
  question?: Question;
  /** Entries on aggregate fields (a kind 'agg' message, or a turn receipt's cost). */
  agg?: {
    /** When the entries count (millis), if it is not createdAt. */
    at?: number;
    entries: { fieldId: string; label: string; unit: string; value: number }[];
  };
  /** A turn receipt: one run of an agent. */
  run?: { n: number; outcome: string; costUsd: number; durationMs: number; model: string | null };
}

export interface ThreadQuery {
  /** Default 50, at most 200. */
  limit?: number;
  /** Only messages older than this message id, or than this time (millis) — page back with the first id you hold. */
  before?: string | number;
}

export interface AggregateQuery {
  /** Field id or label (case-insensitive). Default: the board's first active field. */
  field?: string;
  /** First and last bucket keys, inclusive, in the field's period ('2026-10-01' · '2026-W38' · '2026-07'). */
  from?: string;
  to?: string;
}

/** One period bucket of one field. `tickets` is per ticket KEY. */
export interface AggBucket {
  key: string;
  total: number;
  count: number;
  tickets: Record<string, AggCounter>;
}

/** One field's buckets in a range, oldest first (empty buckets left out). */
export interface Aggregates {
  field: AggField;
  /** The range read: `from` defaults to 30 days / 12 weeks / 12 months back; `to` null = up to now. */
  from: string;
  to: string | null;
  /** Summed over the buckets returned. */
  total: number;
  count: number;
  /** The board's lifetime counter for the field. */
  lifetime: AggCounter;
  buckets: AggBucket[];
}

export interface TicketQuery {
  /** Stage name or id. */
  stage?: string;
  /** 'me', an email, a person / agent id, or null for unassigned. */
  assignee?: string | null;
  /** Default 'active'. */
  state?: 'active' | 'archived';
  /** Default 'rank' (the board's order); 'updated' and 'created' newest first, 'due' soonest first (no date last). */
  orderBy?: 'rank' | 'updated' | 'created' | 'due';
  /** Default 200, at most 500. */
  limit?: number;
}

/** tickets.create takes this; tickets.update takes any subset of it. */
export interface TicketInput {
  title: string;
  /** Markdown. */
  description?: string;
  /** Stage name or id; default the board's first stage. */
  stage?: string;
  /** Priority name or id; null clears it. */
  priority?: string | null;
  /** Tag names (or ids); unknown names are refused, not created. */
  tags?: string[];
  /** 'me', emails, or person / agent ids — members of the board. */
  assignees?: string[];
  /** Millis, or an ISO date / date-time; null clears it. */
  dueAt?: number | string | null;
  startAt?: number | string | null;
  /** Custom fields by name (or id); select options by name. */
  fields?: Record<string, unknown>;
}

/**
 * The tickets of boards the artifact's OWNER granted it (Settings › Board
 * access). Everything happens as the person looking: they see and change only
 * what their own role on that board allows. A board that was not granted, or a
 * write on a read grant, fails with permission-denied.
 */
export interface TicketsApi {
  /** The granted boards this viewer can read, with stages, fields and people. */
  boards(): Promise<Board[]>;
  /** `board` is a key ('ENG') or id. */
  list(board: string, query?: TicketQuery): Promise<Ticket[]>;
  onList(
    board: string,
    query: TicketQuery | null | undefined,
    callback: (tickets: Ticket[]) => void,
    onError?: OnError,
  ): Unsubscribe;
  /** By key ('ENG-42'); null when there is no such ticket. */
  get(key: string): Promise<Ticket | null>;
  create(board: string, ticket: TicketInput): Promise<{ id: string; key: string }>;
  update(key: string, patch: Partial<TicketInput>): Promise<void>;
  /** Post in the ticket's thread, as the viewer. */
  comment(key: string, markdown: string): Promise<void>;
  /**
   * The thread, oldest → newest: the newest `limit` (default 50, at most 200)
   * messages, or those before `before` (a message id or millis) to page back.
   */
  thread(key: string, query?: ThreadQuery): Promise<Message[]>;
  /** The newest messages, live: now and on every change (`before` is refused). */
  onThread(key: string, callback: (messages: Message[]) => void, onError?: OnError): Unsubscribe;
  onThread(
    key: string,
    query: Pick<ThreadQuery, 'limit'> | null | undefined,
    callback: (messages: Message[]) => void,
    onError?: OnError,
  ): Unsubscribe;
  /** A short-lived URL (for <img>, <video>, <a href>) of a file on the ticket — an attachment id. */
  fileUrl(key: string, fileId: string): Promise<string>;
  /** One aggregate field's period buckets on a board. */
  aggregates(board: string, query?: AggregateQuery): Promise<Aggregates>;
  onAggregates(
    board: string,
    query: AggregateQuery | null | undefined,
    callback: (aggregates: Aggregates) => void,
    onError?: OnError,
  ): Unsubscribe;
}

// ─── memory (memory.html §H) ─────────────────────────────────────────────────

/**
 * A memory the artifact's owner granted it, that THIS viewer can reach.
 * `access` is what the page may do with it: the grant, bounded by the viewer.
 */
export interface Memory {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  access: 'read' | 'write';
  files: number;
  bytes: number;
}

/** One folder or file. Paths are relative to the memory ('docs/a.md'). */
export interface MemoryNode {
  id: string;
  kind: 'folder' | 'file';
  path: string;
  name: string;
  /** Files only. */
  mime: string | null;
  size: number | null;
  updatedAt: number;
}

/**
 * Memories (buckets of files) the artifact's OWNER granted it (Settings ›
 * Memory). Everything happens as the person looking: a memory they cannot
 * reach themselves is not listed, and a write needs both a 'write' grant and
 * their own write access. `memory` is a memory id; paths are relative to it.
 */
export interface MemoryApi {
  /** The granted memories this viewer reaches. */
  list(): Promise<Memory[]>;
  /** Every node under `path` (default: the whole memory), sorted by path. */
  tree(memory: string, path?: string): Promise<MemoryNode[]>;
  /** A text file's content (at most 1 MB). */
  read(memory: string, path: string): Promise<string>;
  /** A short-lived URL for <img>, <video>, <audio> or fetch(). */
  url(memory: string, path: string): Promise<string>;
  /** Create or replace a file (≤ 10 MB); missing folders are created. */
  write(
    memory: string,
    path: string,
    content: string | Blob,
    options?: { contentType?: string },
  ): Promise<void>;
  /** Create a folder (and its parents). */
  mkdir(memory: string, path: string): Promise<void>;
  /** Delete a file, or a folder with everything in it. */
  remove(memory: string, path: string): Promise<void>;
}

export interface SignalMap {
  /** This viewer's write access changed. */
  readonly: boolean;
  /** This viewer lost access; every call now fails. */
  revoked: null;
  /** A newer build was published (its id). The host shows a reload bar too. */
  build: string;
}

export interface BackendDriver {
  /** Resolves when the handshake with the host (or the switch to the mock) is done. */
  readonly ready: Promise<void>;
  /** null until `ready`. */
  readonly me: Me | null;
  /** null until `ready`. */
  readonly artifact: ArtifactInfo | null;
  /** true when running OUTSIDE TaskManager, on the in-browser mock backend. */
  readonly mock: boolean;
  readonly serverTime: ServerTime;
  readonly firestore: FirestoreApi;
  readonly rtdb: RtdbApi;
  readonly storage: StorageApi;
  readonly kv: KvApi;
  /** Boards' tickets, where the owner allowed it (§K). */
  readonly tickets: TicketsApi;
  /** Memories (buckets of files), where the owner allowed it (memory.html §H). */
  readonly memory: MemoryApi;
  on<K extends keyof SignalMap>(name: K, callback: (value: SignalMap[K]) => void): Unsubscribe;
}

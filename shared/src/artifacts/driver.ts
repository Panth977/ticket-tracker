/**
 * THE DRIVER PROTOCOL (docs/plan/artifacts.html §E) — what crosses
 * postMessage between the artifact (window.BackendDriver, in a sandboxed
 * iframe with an opaque origin) and the host page (/x/{id}, our code, the
 * viewer's real session).
 *
 *   iframe → host   ready · req · unsub
 *   host → iframe   hello · res · event · signal
 *
 * The iframe NEVER sends an artifact id or a full path: every `args.path` is
 * the artifact's own view ('/my/doc'), and the host prefixes it with the id it
 * holds itself (./paths.ts). The host accepts messages only when
 * `event.source === iframe.contentWindow`, and posts with targetOrigin '*'
 * (an opaque origin has no name to target) — which is fine, because the only
 * window that can receive it is the iframe it created.
 *
 * Values cross as structured clones: Firestore Timestamps arrive as Date, a
 * Date written becomes a Timestamp, and SERVER_TIME anywhere in a written
 * value becomes the server timestamp.
 */
import type { ArtifactBoardAccess, ArtifactRole } from './schema.js';

/** Every message carries this, so a page's other postMessage traffic is ignored. */
export const DRIVER_TAG = 'tm-artifact' as const;
export const DRIVER_PROTOCOL_VERSION = 1 as const;
/** Where the driver is served on the app site (§E1). */
export const DRIVER_PATH = '/backend-driver/v1/driver.js';
export const DRIVER_MODULE_PATH = '/backend-driver/v1/driver.mjs';
export const DRIVER_TYPES_PATH = '/backend-driver/v1/driver.d.ts';

/** The sentinel db.serverTime is; the host swaps it for serverTimestamp(). */
export const SERVER_TIME = { __tm: 'serverTime' } as const;
export type ServerTime = typeof SERVER_TIME;
export const isServerTime = (v: unknown): v is ServerTime =>
  !!v && typeof v === 'object' && (v as { __tm?: unknown }).__tm === 'serverTime';

export type WhereOp =
  '<' | '<=' | '==' | '!=' | '>=' | '>' | 'array-contains' | 'in' | 'not-in' | 'array-contains-any';
export const WHERE_OPS: readonly WhereOp[] = [
  '<',
  '<=',
  '==',
  '!=',
  '>=',
  '>',
  'array-contains',
  'in',
  'not-in',
  'array-contains-any',
];

/** A Blob / File as it crosses postMessage (shared has no DOM lib; the driver's .d.ts says Blob). */
export interface BlobLike {
  readonly size: number;
  readonly type: string;
}

export interface ListQuery {
  where?: [field: string, op: WhereOp, value: unknown][];
  orderBy?: [field: string, dir?: 'asc' | 'desc'];
  /** Capped at 500 by the host. */
  limit?: number;
  /** A document id (in this collection) to start after — the last id of the previous page. */
  startAfter?: string;
}
export const LIST_LIMIT_MAX = 500;

/** A document as the artifact sees it. `path` is in the artifact's own view. */
export interface DriverDoc<T = Record<string, unknown>> {
  id: string;
  path: string;
  exists: boolean;
  data: T | null;
}

/** Who is looking (db.me). */
export interface DriverMe {
  uid: string;
  name: string | null;
  email: string | null;
  photoURL: string | null;
  role: ArtifactRole;
  readOnly: boolean;
}

export interface DriverArtifact {
  id: string;
  name: string;
  buildId: string;
}

// ─── §K: a board's tickets (BackendDriver.tickets) ─────────────────────────────

/** A person or agent as the page sees one. */
export interface DriverPerson {
  id: string;
  kind: 'user' | 'agent';
  name: string;
  /** '' for agents. */
  email: string;
}

/** A board the owner granted this artifact (tickets.boards()). */
export interface DriverBoard {
  id: string;
  key: string;
  name: string;
  /** What the OWNER granted. */
  access: ArtifactBoardAccess;
  /** May THIS viewer change tickets here through the page (grant 'write' AND their own role)? */
  canWrite: boolean;
  stages: { id: string; name: string; category: string }[];
  priorities: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  fields: { id: string; name: string; type: string; options?: string[] }[];
  members: DriverPerson[];
}

/** A ticket as the page sees it: names, not ids; Markdown, not rich text; millis for times. */
export interface DriverTicket {
  id: string;
  key: string;
  board: string;
  url: string;
  title: string;
  description: string;
  stage: { id: string; name: string; category: string };
  priority: { id: string; name: string } | null;
  tags: string[];
  assignees: DriverPerson[];
  state: 'active' | 'archived';
  startAt: number | null;
  dueAt: number | null;
  /** Custom fields by NAME; select options by name. */
  fields: Record<string, unknown>;
  messages: number;
  createdAt: number;
  updatedAt: number;
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
  /** Default 200, capped at 500. */
  limit?: number;
}

/** What tickets.create takes, and tickets.update patches (every field optional there). */
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
 * A memory this artifact was granted (memory.html §H) that the VIEWER reaches.
 * `access` is what this page may do with it: the grant, bounded by the viewer.
 */
export interface DriverMemory {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  access: 'read' | 'write';
  files: number;
  bytes: number;
}

/** One node of a memory's tree. Paths are relative to the memory ('docs/a.md'). */
export interface DriverMemoryNode {
  id: string;
  kind: 'folder' | 'file';
  path: string;
  name: string;
  /** Files only. */
  mime: string | null;
  size: number | null;
  updatedAt: number;
}

/** Operation → [args, result]. The one table both sides are typed from. */
export interface DriverOps {
  'fs.get': [{ path: string }, DriverDoc];
  'fs.set': [{ path: string; data: Record<string, unknown>; merge?: boolean }, { ok: true }];
  'fs.update': [{ path: string; patch: Record<string, unknown> }, { ok: true }];
  'fs.delete': [{ path: string }, { ok: true }];
  'fs.add': [{ path: string; data: Record<string, unknown> }, { id: string; path: string }];
  'fs.list': [{ path: string; query?: ListQuery }, DriverDoc[]];
  /** Subscriptions answer { sub } at once; snapshots follow as `event` messages. */
  'fs.onDoc': [{ path: string }, { sub: string }];
  'fs.onList': [{ path: string; query?: ListQuery }, { sub: string }];
  'rtdb.get': [{ path: string }, unknown];
  'rtdb.set': [{ path: string; value: unknown }, { ok: true }];
  'rtdb.update': [{ path: string; patch: Record<string, unknown> }, { ok: true }];
  'rtdb.push': [{ path: string; value: unknown }, { key: string; path: string }];
  'rtdb.remove': [{ path: string }, { ok: true }];
  'rtdb.on': [{ path: string }, { sub: string }];
  'st.upload': [
    { path: string; blob: BlobLike; contentType?: string },
    { path: string; size: number },
  ];
  'st.url': [{ path: string }, { url: string; expiresAt: number }];
  'st.list': [
    { path: string },
    { path: string; size: number; contentType: string | null; updatedAt: number }[],
  ];
  'st.delete': [{ path: string }, { ok: true }];
  'kv.get': [{ key: string }, unknown];
  'kv.set': [{ key: string; value: unknown }, { ok: true }];
  'kv.delete': [{ key: string }, { ok: true }];
  // §K — board tickets, through the owner's grant and the viewer's own role
  'tk.boards': [Record<string, never>, DriverBoard[]];
  'tk.list': [{ board: string; query?: TicketQuery }, DriverTicket[]];
  'tk.onList': [{ board: string; query?: TicketQuery }, { sub: string }];
  'tk.get': [{ key: string }, DriverTicket | null];
  'tk.create': [{ board: string; ticket: TicketInput }, { id: string; key: string }];
  'tk.update': [{ key: string; patch: Partial<TicketInput> }, { ok: true }];
  'tk.comment': [{ key: string; markdown: string }, { ok: true }];
  // memory.html §H — memories granted to this artifact, as far as the viewer reaches
  'mem.list': [Record<string, never>, DriverMemory[]];
  'mem.tree': [{ memory: string; path?: string }, DriverMemoryNode[]];
  'mem.read': [{ memory: string; path: string }, { text: string; truncated: boolean }];
  'mem.url': [{ memory: string; path: string }, { url: string; expiresAt: number }];
  'mem.write': [
    { memory: string; path: string; text?: string; blob?: BlobLike; contentType?: string },
    { path: string },
  ];
  'mem.mkdir': [{ memory: string; path: string }, { path: string }];
  'mem.remove': [{ memory: string; path: string }, { ok: true }];
}
export type DriverOp = keyof DriverOps;
export type DriverArgs<O extends DriverOp> = DriverOps[O][0];
export type DriverResult<O extends DriverOp> = DriverOps[O][1];
export const DRIVER_OPS = [
  'fs.get',
  'fs.set',
  'fs.update',
  'fs.delete',
  'fs.add',
  'fs.list',
  'fs.onDoc',
  'fs.onList',
  'rtdb.get',
  'rtdb.set',
  'rtdb.update',
  'rtdb.push',
  'rtdb.remove',
  'rtdb.on',
  'st.upload',
  'st.url',
  'st.list',
  'st.delete',
  'kv.get',
  'kv.set',
  'kv.delete',
  'tk.boards',
  'tk.list',
  'tk.onList',
  'tk.get',
  'tk.create',
  'tk.update',
  'tk.comment',
  'mem.list',
  'mem.tree',
  'mem.read',
  'mem.url',
  'mem.write',
  'mem.mkdir',
  'mem.remove',
] as const satisfies readonly DriverOp[];
/** Ops that write: refused up front when the viewer is read-only (the rules refuse them anyway). */
export const DRIVER_WRITE_OPS: ReadonlySet<DriverOp> = new Set([
  'fs.set',
  'fs.update',
  'fs.delete',
  'fs.add',
  'rtdb.set',
  'rtdb.update',
  'rtdb.push',
  'rtdb.remove',
  'st.upload',
  'st.delete',
  // §K: a read-only artifact stays read-only for its viewers, tickets included.
  'tk.create',
  'tk.update',
  'tk.comment',
  // memory.html §H: the same for memory writes.
  'mem.write',
  'mem.mkdir',
  'mem.remove',
]);
export const isDriverOp = (s: unknown): s is DriverOp =>
  typeof s === 'string' && (DRIVER_OPS as readonly string[]).includes(s);

export type DriverErrorCode =
  'permission-denied' | 'not-found' | 'invalid-argument' | 'quota' | 'unavailable';
export interface DriverError {
  code: DriverErrorCode;
  message: string;
}

interface Base {
  tag: typeof DRIVER_TAG;
  v: typeof DRIVER_PROTOCOL_VERSION;
}

// ── iframe → host ───────────────────────────────────────────────────────────
/** The driver loaded; the host answers with `hello`. Re-sent every 500 ms until it does. */
export interface ReadyMsg extends Base {
  type: 'ready';
}
export interface ReqMsg<O extends DriverOp = DriverOp> extends Base {
  type: 'req';
  /** Unique per request within this iframe. */
  id: string;
  op: O;
  args: DriverArgs<O>;
}
/** Stop a subscription (the unsubscribe() a subscription returned). */
export interface UnsubMsg extends Base {
  type: 'unsub';
  sub: string;
}
export type FromArtifact = ReadyMsg | ReqMsg | UnsubMsg;

// ── host → iframe ───────────────────────────────────────────────────────────
export interface HelloMsg extends Base {
  type: 'hello';
  artifact: DriverArtifact;
  me: DriverMe;
}
export type ResMsg =
  | (Base & { type: 'res'; id: string; ok: true; value: unknown })
  | (Base & { type: 'res'; id: string; ok: false; error: DriverError });
/** A snapshot for a subscription: DriverDoc for fs.onDoc, DriverDoc[] for fs.onList, the value for rtdb.on. */
export type EventMsg =
  | (Base & { type: 'event'; sub: string; ok: true; value: unknown })
  | (Base & { type: 'event'; sub: string; ok: false; error: DriverError });
/**
 *   readonly  the viewer's write access changed (value: boolean)
 *   revoked   the viewer lost access; every call now fails (value: null)
 *   build     a newer build was published (value: buildId) — the host shows a reload bar too
 */
export interface SignalMsg extends Base {
  type: 'signal';
  name: 'readonly' | 'revoked' | 'build';
  value: unknown;
}
export type FromHost = HelloMsg | ResMsg | EventMsg | SignalMsg;

export function isDriverMessage(data: unknown): data is FromArtifact | FromHost {
  return (
    !!data &&
    typeof data === 'object' &&
    (data as { tag?: unknown }).tag === DRIVER_TAG &&
    (data as { v?: unknown }).v === DRIVER_PROTOCOL_VERSION &&
    typeof (data as { type?: unknown }).type === 'string'
  );
}

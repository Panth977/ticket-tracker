/**
 * THE PHASE-2 API OPERATIONS (docs/plan/agents.html §F, §G) — one
 * implementation behind both REST /v1 (doors/rest.ts) and MCP (doors/mcp.ts),
 * so an orchestrator sees the same answers whichever door it uses.
 *
 * Reads map documents to the public shapes (public.ts). Writes go through
 * THE SAME COMMANDS the app calls (ops.invoke): messagePost, ticketUpdate,
 * ticketState, agentInboxAck. The two exceptions are not commands in the
 * app either:
 *   - storing an uploaded blob (uploads.ts) — the app uploads straight to
 *     Storage; a token has no Storage access, so the door does the PUT;
 *   - marking a PERSON's own inbox rows read — the app writes readAt on its
 *     own inbox directly (INBOX_CLIENT_FIELDS).
 */
import {
  COLLECTIONS,
  errors,
  isAgentId,
  isTextualKind,
  MAX_INLINE_TEXT_BYTES,
  parseTicketPath,
  paths,
  SCOPES,
  SIGNED_URL_TTL_MS,
  toIso,
  fileInfo,
  hasScope,
  type Agent,
  type AgentInboxEvent,
  type BoardMember,
  type BoardWithId,
  type InboxItem,
  type Message,
  type PublicBoard,
  type PublicEvent,
  type PublicFile,
  type PublicMessage,
  type PublicMemoryFileRef,
  type PublicRunReceipt,
  type PublicAggBuckets,
  type PublicAggInput,
  type AggFieldDef,
  type AggStats,
  type MessageAgg,
  activeAggFields,
  aggAtFrom,
  aggKeyFits,
  aggPeriodKeys,
  boardAggFields,
  type PublicTicket,
  type PublicTicketDetail,
  type RestFileRes,
  type RestMeRes,
  type StoredMessage,
  type Ticket,
  type TicketFile,
  type TicketState,
  type TicketWithId,
  type User,
} from '@tm/shared';
import { effectiveRole } from '@tm/shared/logic/index';
import { ports } from '../adapters/index.js';
import type { ApiKeyInfo } from '../middleware/apiKey.js';
import type { ServerCtx } from '../runtime/context.js';
import { db } from '../runtime/firebase.js';
import { loadBoard, loadTicket, requireCan } from '../tickets/access.js';
import { getMessage, readThread, recentAndPinned } from '../tickets/read.js';
import { clientIdFor, invoke, updateTicket } from './ops.js';
import {
  boardMembers,
  runIn,
  toPublicAgentEvent,
  toPublicBoard,
  toPublicFile,
  toPublicInboxEvent,
  toPublicMessages,
  toPublicPerson,
  toPublicTicket,
  toPublicAggField,
  toPublicAggs,
} from './public.js';
import { decodeCursor, encodeCursor, markdownIn, peopleUids, readableBoards } from './resolve.js';
import { requireFileRead } from './fileAccess.js';
import { memoryRefsIn } from '../memory/refs.js';

/** The API key behind a ctx, when one authenticated the request (middleware/apiKey.ts). */
export const apiKeyOf = (ctx: ServerCtx): ApiKeyInfo | null =>
  (ctx as ServerCtx & { apiKey?: ApiKeyInfo }).apiKey ?? null;

const boardRef = (b: Pick<BoardWithId, 'id' | 'key' | 'name'>) => ({
  id: b.id,
  key: b.key,
  name: b.name,
});

/** A download URL valid SIGNED_URL_TTL_MS (15 min). */
export async function signedUrl(
  path: string,
  now: number,
): Promise<{ url: string; expiresAt: number }> {
  const expiresAt = now + SIGNED_URL_TTL_MS;
  return { url: await ports().files.signedDownloadUrl(path, expiresAt), expiresAt };
}

// ─── who am I ────────────────────────────────────────────────────────────────

/**
 * GET /v1/me, MCP whoami. For an agent token: everything an orchestrator
 * needs to start the agent — name, description, avatar and SYSTEM PROMPT —
 * so the prompt loads from the token alone.
 *
 * §R2 — it also says WHICH KIND of credential this is. A board token answers
 * kind 'board' with its one `board`; an ACCOUNT token answers kind 'account'
 * with board: null and `boards` = every board reachable AT THIS CALL (the
 * list is read now, not remembered), so a client never has to guess whether
 * it must name a board. §AA1: an AGENT token answers kind 'agent' with
 * `boards` = every board the agent is on, `board` = the one a call that names
 * none would get (or null when it must name one), and `default_board`.
 */
export async function whoami(ctx: ServerCtx): Promise<RestMeRes> {
  const key = apiKeyOf(ctx);
  const agent = isAgentId(ctx.actor);
  const ownerUid = ctx.ownerUid ?? ctx.actor;
  const [principalSnap, ownerSnap, boards] = await Promise.all([
    db()
      .doc(agent ? paths.agent(ctx.actor) : paths.user(ctx.actor))
      .get(),
    agent ? db().doc(paths.user(ownerUid)).get() : Promise.resolve(null),
    readableBoards(ctx, { includeArchived: true }),
  ]);
  // A board token narrows to exactly one board; account tokens and OAuth
  // grants list what they reach instead.
  //
  // §AA1 — an AGENT token lists what the agent reaches too, and ALSO says
  // which board a call that names none gets, exactly as requestBoard decides
  // it: the only live board it is on, else its default board (a token
  // converted from a board token, §AA6) while the agent is still on it. So a
  // client that read `board` from a one-board agent token reads the same
  // thing after the conversion.
  const agentToken = key?.kind === 'agent';
  const live = boards.filter((b) => b.archivedAt === null);
  const dflt = agentToken ? (live.find((b) => b.id === ctx.defaultBoardId) ?? null) : null;
  const implied = agentToken ? (live.length === 1 ? live[0]! : dflt) : null;
  const single = ctx.boardIds?.length === 1 ? (boards[0] ?? null) : implied;
  const kind: RestMeRes['kind'] = key ? key.kind : 'oauth';
  // The board's member rows mirror names and emails; a fallback when a profile is missing.
  const members = single ? await boardMembers(single.id) : new Map<string, BoardMember>();

  let principal: RestMeRes['principal'];
  if (agent) {
    const a = principalSnap.data() as Agent | undefined;
    principal = {
      kind: 'agent',
      id: ctx.actor,
      name: a?.name ?? ctx.actor,
      email: null,
      avatar_url: a?.avatarPath ? (await signedUrl(a.avatarPath, ctx.now)).url : null,
      icon: a?.icon ?? null,
      description: a?.description ?? null,
      system_prompt: a?.systemPrompt ?? '',
    };
  } else {
    const u = principalSnap.data() as User | undefined;
    const m = members.get(ctx.actor);
    principal = {
      kind: 'user',
      id: ctx.actor,
      name: u?.name ?? m?.name ?? '',
      email: u?.email ?? m?.email ?? null,
      avatar_url: u?.avatarPath ? (await signedUrl(u.avatarPath, ctx.now)).url : null,
      icon: null,
    };
  }
  const owner = ownerSnap?.exists ? (ownerSnap.data() as User) : null;
  const via = ctx.via === 'mcp' || ctx.via === 'integration' ? ctx.via : 'api';
  return {
    principal,
    owner: agent
      ? {
          id: ownerUid,
          name: owner?.name ?? members.get(ownerUid)?.name ?? '',
          email: owner?.email ?? members.get(ownerUid)?.email ?? '',
        }
      : null,
    kind,
    board: single ? boardRef(single) : null,
    ...(single && !agentToken ? {} : { boards: boards.map(boardRef) }),
    ...(agentToken ? { default_board: dflt ? boardRef(dflt) : null } : {}),
    role: single ? effectiveRole(single, ctx.actor) : null,
    scopes: ctx.scopes ? [...ctx.scopes] : [...SCOPES],
    via,
    token: key
      ? {
          id: key.keyId,
          name: key.name,
          prefix: key.prefix,
          expires_at: toIso(key.expiresAt),
          kind: key.kind,
        }
      : null,
  };
}

// ─── board ───────────────────────────────────────────────────────────────────

/** GET /v1/board, MCP get_board: members (people + agents) only with members:read. */
export async function boardView(ctx: ServerCtx, board: BoardWithId): Promise<PublicBoard> {
  const withMembers = hasScope(ctx.scopes, 'members:read');
  return toPublicBoard(board, withMembers ? await boardMembers(board.id) : undefined);
}

// ─── tickets ─────────────────────────────────────────────────────────────────

/**
 * Every live file on a ticket. §W: they are a field of the ticket the caller
 * already read — no query, no second document.
 */
function ticketFiles(_board: BoardWithId, ticket: TicketWithId): TicketFile[] {
  return (ticket.files ?? [])
    .filter((f) => f.deletedAt === null)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * GET /v1/tickets/{KEY}, MCP get_ticket: the ticket plus what an agent needs
 * to start work — watchers, pinned messages, files, and the last N messages
 * when asked (oldest first). Files and messages need their read scopes.
 */
export async function ticketDetail(
  ctx: ServerCtx,
  board: BoardWithId,
  ticket: TicketWithId,
  lastMessages = 0,
): Promise<PublicTicketDetail> {
  const readComments = hasScope(ctx.scopes, 'comments:read');
  const readFiles = hasScope(ctx.scopes, 'files:read');
  // §W: the pinned messages, the last N messages and the files are all fields
  // of the ticket document — 'opening a ticket costs NOTHING extra'.
  const [pub, members, thread] = await Promise.all([
    toPublicTicket(board, ticket),
    boardMembers(board.id),
    readComments
      ? recentAndPinned(board.id, ticket.id, Math.max(lastMessages, 0), ticket)
      : Promise.resolve({ recent: [], pinned: [] }),
  ]);
  const files = readFiles ? ticketFiles(board, ticket) : [];
  const rows = (list: readonly StoredMessage[]) =>
    list.map((m) => ({ id: m.id, message: m as Message }));
  const pinned = rows(thread.pinned);
  const recent = lastMessages > 0 ? rows(thread.recent) : [];
  const [pinnedPub, recentPub] = await Promise.all([
    toPublicMessages(board.id, ticket.key, pinned, ticket.id, ctx.now),
    toPublicMessages(board.id, ticket.key, recent, ticket.id, ctx.now),
  ]);
  return {
    ...pub,
    watchers: ticket.watcherUids.map((id) => toPublicPerson(members, id)),
    pinned_messages: pinnedPub,
    files: files.map((f) => toPublicFile(ticket.key, f, members)),
    ...(lastMessages > 0 && readComments ? { messages: recentPub } : {}),
    counts: { messages: ticket.counts.messages, files: files.length || ticket.counts.files },
  };
}

/** POST /v1/tickets/{KEY}/state — ticketState, answers the ticket. */
export async function setTicketState(
  ctx: ServerCtx,
  board: BoardWithId,
  ticket: TicketWithId,
  state: TicketState,
  key?: string,
): Promise<PublicTicket> {
  if (ticket.state !== state) {
    await invoke(
      'ticketState',
      { boardId: board.id, ticketId: ticket.id, state },
      ctx,
      key ?? null,
    );
  }
  return toPublicTicket(board, await loadTicket(board.id, ticket.id));
}

/**
 * Add / remove assignees without replacing the list (REST …/assignees, MCP
 * assign_ticket). Names resolve like everywhere else (me, id, email, agent name).
 */
export async function assignTicket(
  ctx: ServerCtx,
  board: BoardWithId,
  ticket: TicketWithId,
  add: readonly string[] = [],
  remove: readonly string[] = [],
  key?: string,
): Promise<PublicTicket> {
  const members = await boardMembers(board.id);
  const plus = peopleUids(ctx, board, members, add);
  const minus = new Set(peopleUids(ctx, board, members, remove));
  const next = [...new Set([...ticket.assigneeUids, ...plus])].filter((u) => !minus.has(u));
  const same =
    next.length === ticket.assigneeUids.length &&
    next.every((u) => ticket.assigneeUids.includes(u));
  if (same) return toPublicTicket(board, ticket);
  // updateTicket re-resolves names; ids resolve to themselves.
  return updateTicket(ctx, board, ticket, { assignees: next }, key);
}

// ─── messages ────────────────────────────────────────────────────────────────

interface MsgCursor {
  c: number;
  id: string;
}

/**
 * GET /v1/tickets/{KEY}/messages, MCP get_messages — Markdown bodies,
 * attachments with file ids.
 *
 * §W: the inline window answers this without a query; only a caller paging
 * back past `oldestInlineAt` pays for a data page. The cursor is unchanged
 * ((createdAt, id), opaque), so an agent's saved cursor still works.
 */
export async function messagesPage(
  ctx: ServerCtx,
  board: BoardWithId,
  ticket: TicketWithId,
  q: { cursor?: string | undefined; limit: number; order?: 'asc' | 'desc' },
): Promise<{ data: PublicMessage[]; next_cursor: string | null }> {
  const dir = q.order ?? 'asc';
  const cur = decodeCursor<MsgCursor>(q.cursor);
  const { rows, hasMore } = await readThread(board.id, ticket.id, {
    ticket,
    order: dir,
    limit: q.limit,
    ...(cur ? { after: { createdAt: cur.c, id: cur.id } } : {}),
  });
  const page = rows.map((m) => ({ id: m.id, message: m as Message }));
  const last = rows[rows.length - 1];
  return {
    data: await toPublicMessages(board.id, ticket.key, page, ticket.id, ctx.now),
    next_cursor: hasMore && last ? encodeCursor({ c: last.createdAt, id: last.id }) : null,
  };
}

/**
 * POST /v1/tickets/{KEY}/messages, MCP post_message: Markdown in → messagePost
 * with the rich-text body (mentions of people AND agents resolved), the
 * Markdown source kept as Message.markdown, and files already uploaded to the
 * ticket attached by id. A message may be files only.
 *
 * Phase 17 (§Y1): `run` is the turn receipt an orchestrator attaches when one
 * run of the agent ends; messagePost stores it and moves the cost counters.
 */
export async function postMessage(
  ctx: ServerCtx,
  board: BoardWithId,
  ticket: TicketWithId,
  m: {
    markdown: string;
    fileIds?: string[] | undefined;
    replyTo?: string | undefined;
    run?: PublicRunReceipt | null | undefined;
    /** aggregates.html: entries naming their field by id or label. */
    agg?: PublicAggInput | undefined;
    /** memory.html §E: memory files by reference. */
    memoryFiles?: PublicMemoryFileRef[] | undefined;
  },
  key?: string,
): Promise<PublicMessage> {
  const md = m.markdown ?? '';
  const body = md.trim() ? await markdownIn(md, board) : { type: 'doc' as const, content: [] };
  const res = await invoke(
    'messagePost',
    {
      boardId: board.id,
      ticketId: ticket.id,
      body,
      ...(md.trim() ? { markdown: md } : {}),
      ...(m.fileIds?.length ? { fileIds: [...new Set(m.fileIds)] } : {}),
      ...(m.memoryFiles?.length ? { memoryRefs: await memoryRefsIn(m.memoryFiles) } : {}),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      ...(m.run ? { run: runIn(m.run) } : {}),
      ...(m.agg ? { agg: aggIn(board, m.agg) } : {}),
      clientId: clientIdFor(key, ctx),
    },
    ctx,
    key ?? null,
  );
  const posted = await getMessage(board.id, ticket.id, res.messageId);
  const [pub] = await toPublicMessages(
    board.id,
    ticket.key,
    [{ id: res.messageId, message: posted as Message }],
    ticket.id,
    ctx.now,
  );
  return pub!;
}

// ─── aggregates (aggregates.html) ────────────────────────────────────────────

/**
 * A field named by the API — its id, else its label (case-insensitive; an
 * active field wins over an archived one of the same label). 400 when none.
 */
export function aggFieldFor(board: BoardWithId, ref: string, what = 'agg'): AggFieldDef {
  const fields = boardAggFields(board);
  const want = ref.trim().toLowerCase();
  const f =
    fields.find((x) => x.id === ref) ??
    fields.find((x) => !x.archived && x.label.toLowerCase() === want) ??
    fields.find((x) => x.label.toLowerCase() === want);
  if (!f)
    throw errors.invalid(
      `No aggregate field "${ref}" on ${board.key} (have: ${fields.map((x) => x.label).join(', ') || 'none'})`,
      { field: what },
    );
  return f;
}

/** The wire entries (field_id | field) → what messagePost takes (it checks archived / duplicates). */
export function aggIn(board: BoardWithId, agg: PublicAggInput): MessageAgg {
  let at: number | undefined;
  if (agg.at !== undefined) {
    const ms = aggAtFrom(agg.at);
    if (ms === null)
      throw errors.invalid("agg.at: give a date ('2026-10-04'), an ISO date-time or millis", {
        field: 'agg',
      });
    at = ms;
  }
  return {
    ...(at !== undefined ? { at } : {}),
    entries: agg.entries.map((e) => ({
      fieldId: aggFieldFor(board, (e.field_id ?? e.field)!).id,
      value: e.value,
    })),
  };
}

const AGG_DEFAULT_BUCKETS = { daily: 30, weekly: 12, monthly: 12 } as const;

/** GET /v1/boards/{KEY}/aggregates, MCP get_aggregates: one field's buckets, oldest first. */
export async function aggregateBuckets(
  ctx: ServerCtx,
  board: BoardWithId,
  q: { field?: string | undefined; from?: string | undefined; to?: string | undefined },
): Promise<PublicAggBuckets> {
  const first = activeAggFields(board)[0] ?? boardAggFields(board)[0];
  if (!q.field && !first)
    throw errors.invalid('This board has no aggregate fields', { field: 'field' });
  const field = q.field ? aggFieldFor(board, q.field, 'field') : first!;
  for (const [k, v] of [
    ['from', q.from],
    ['to', q.to],
  ] as const)
    if (v !== undefined && !aggKeyFits(field.period, v))
      throw errors.invalid(`${k}: "${v}" is not a ${field.period} key`, { field: k });
  const from =
    q.from ?? aggPeriodKeys(field.period, ctx.now, AGG_DEFAULT_BUCKETS[field.period])[0]!;
  let qy = db()
    .collection(paths.aggStats(board.id))
    .where('period', '==', field.period)
    .where('key', '>=', from);
  if (q.to) qy = qy.where('key', '<=', q.to);
  const snap = await qy.orderBy('key', 'asc').limit(400).get();
  const buckets = snap.docs
    .map((d) => d.data() as AggStats)
    .map((d) => ({ key: d.key, c: d.fields[field.id] }))
    .filter((x) => x.c && x.c.count > 0)
    .map(({ key, c }) => ({
      key,
      total: c!.total,
      count: c!.count,
      tickets: Object.fromEntries(
        Object.entries(c!.tickets).map(([k, v]) => [k, { total: v.total, count: v.count }]),
      ),
    }));
  const total = toPublicAggs(board)[field.id] ?? { total: 0, count: 0 };
  return { field: toPublicAggField(field), total, buckets };
}

// ─── files ───────────────────────────────────────────────────────────────────

/** Every live file on a ticket (GET /v1/tickets/{KEY}/files). */
export async function listTicketFiles(
  board: BoardWithId,
  ticket: TicketWithId,
): Promise<PublicFile[]> {
  const members = await boardMembers(board.id);
  return ticketFiles(board, ticket).map((f) => toPublicFile(ticket.key, f, members));
}

/**
 * A file by id, wherever it lives — among the boards this credential can
 * read.
 *
 * §W: there is no files/ collection group any more, so the ticket carries a
 * flat `fileIds` of its LIVE files and one collection-group query finds the
 * ticket that holds it (single-field array index, collection-group scope in
 * firestore.indexes.json). The file row itself then comes out of that ticket.
 */
export async function findFile(
  ctx: ServerCtx,
  fileId: string,
): Promise<{ board: BoardWithId; ticket: TicketWithId; file: TicketFile }> {
  if (!fileId || fileId.includes('/')) throw errors.not_found('File not found');
  const snap = await db()
    .collectionGroup(COLLECTIONS.tickets)
    .where('fileIds', 'array-contains', fileId)
    .limit(10)
    .get();
  for (const d of snap.docs) {
    const at = parseTicketPath(d.ref.path);
    if (!at) continue;
    const ticket = d.data() as Ticket;
    const file = (ticket.files ?? []).find((f) => f.id === fileId && f.deletedAt === null);
    if (!file) continue;
    let board: BoardWithId;
    try {
      board = await loadBoard(ctx, at.boardId);
    } catch {
      continue; // not readable with this credential: indistinguishable from missing
    }
    return { board, ticket: { ...ticket, id: at.ticketId, boardId: at.boardId }, file };
  }
  throw errors.not_found('File not found');
}

/**
 * GET /v1/files/{fileId} (?content=1), MCP read_file: metadata and a signed
 * download URL valid 15 min; with content, the text of textual kinds
 * (Markdown, HTML, text, CSV, JSON, code), cut at MAX_INLINE_TEXT_BYTES.
 */
export async function readFile(
  ctx: ServerCtx,
  fileId: string,
  /** true: text or 422; 'auto': text when textual, else just the URL (MCP read_file). */
  withContent: boolean | 'auto',
): Promise<RestFileRes> {
  const { board, ticket, file } = await findFile(ctx, fileId);
  // memory.html §E: a memory reference is the node's CURRENT version, and only
  // while the memory is still granted (the file door decides both).
  const path = file.memory ? await requireFileRead(ctx, file.path) : file.path;
  const [members, signed] = await Promise.all([boardMembers(board.id), signedUrl(path, ctx.now)]);
  const pub = toPublicFile(ticket.key, file, members, signed);
  if (!withContent) return pub;
  const textual = isTextualKind(fileInfo(file.mime, file.name).kind);
  if (!textual && withContent === 'auto') return pub;
  if (!textual)
    throw errors.unprocessable(`This is a ${pub.kind} file — download it from url instead`, {
      kind: pub.kind,
      url: signed.url,
    });
  const bytes = await ports().files.read(path);
  const cut = bytes.length > MAX_INLINE_TEXT_BYTES;
  const content = new TextDecoder('utf-8', { fatal: false }).decode(
    cut ? bytes.subarray(0, MAX_INLINE_TEXT_BYTES) : bytes,
  );
  return { ...pub, content, ...(cut ? { content_truncated: true } : {}) };
}

// ─── events ──────────────────────────────────────────────────────────────────

/** A person's inbox cursor: rows are ordered by (createdAt, id). */
interface InboxCursor {
  c: number;
  id: string;
}

export interface EventsPage {
  data: PublicEvent[];
  /** The cursor AFTER each event (the SSE id): the event id for agents, an opaque cursor for people. */
  cursors: string[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * The token's inbox, oldest first, after `cursor` (GET /v1/events, the SSE
 * stream, MCP get_events). An agent token reads agentInbox/{agentId}/events
 * (ids sort by time, so an event id IS a cursor); a person's token reads
 * their own in-app inbox. Either way only events of the credential's boards.
 */
export async function eventsPage(
  ctx: ServerCtx,
  q: { cursor?: string | undefined; limit: number; unacked?: boolean | undefined },
): Promise<EventsPage> {
  const boards = await readableBoards(ctx, { includeArchived: true });
  const byId = new Map(boards.map((b) => [b.id, b]));
  if (!boards.length)
    return { data: [], cursors: [], next_cursor: q.cursor ?? null, has_more: false };
  const memberCache = new Map<string, Map<string, BoardMember>>();
  const members = async (boardId: string) => {
    let m = memberCache.get(boardId);
    if (!m) memberCache.set(boardId, (m = await boardMembers(boardId)));
    return m;
  };
  const inBoards = boards.slice(0, 30).map((b) => b.id); // Firestore 'in' takes ≤ 30

  if (isAgentId(ctx.actor)) {
    let qy = db()
      .collection(paths.agentEvents(ctx.actor))
      .where(
        'boardId',
        inBoards.length === 1 ? '==' : 'in',
        inBoards.length === 1 ? inBoards[0]! : inBoards,
      );
    if (q.unacked) qy = qy.where('ackedAt', '==', null);
    qy = qy.orderBy('__name__');
    if (q.cursor) qy = qy.startAfter(q.cursor);
    const snap = await qy.limit(q.limit + 1).get();
    const docs = snap.docs.slice(0, q.limit);
    const data: PublicEvent[] = [];
    for (const d of docs) {
      const e = d.data() as AgentInboxEvent;
      const b = byId.get(e.boardId)!;
      data.push(toPublicAgentEvent(d.id, e, boardRef(b), await members(b.id)));
    }
    const last = docs[docs.length - 1];
    return {
      data,
      cursors: data.map((e) => e.id),
      next_cursor: last ? last.id : (q.cursor ?? null),
      has_more: snap.docs.length > q.limit,
    };
  }

  const cur = decodeCursor<InboxCursor>(q.cursor);
  let qy = db()
    .collection(paths.inbox(ctx.actor))
    .where(
      'boardId',
      inBoards.length === 1 ? '==' : 'in',
      inBoards.length === 1 ? inBoards[0]! : inBoards,
    );
  if (q.unacked) qy = qy.where('readAt', '==', null);
  qy = qy.orderBy('createdAt').orderBy('__name__');
  if (cur) qy = qy.startAfter(cur.c, cur.id);
  const snap = await qy.limit(q.limit + 1).get();
  const docs = snap.docs.slice(0, q.limit);
  const data: PublicEvent[] = [];
  const cursors: string[] = [];
  for (const d of docs) {
    const e = d.data() as InboxItem;
    const b = byId.get(e.boardId)!;
    const pub = toPublicInboxEvent(d.id, e, boardRef(b), await members(b.id));
    if (pub) {
      data.push(pub);
      cursors.push(encodeCursor({ c: e.createdAt, id: d.id }));
    }
  }
  const last = docs[docs.length - 1];
  return {
    data,
    cursors,
    next_cursor: last
      ? encodeCursor({ c: (last.data() as InboxItem).createdAt, id: last.id })
      : (q.cursor ?? null),
    has_more: snap.docs.length > q.limit,
  };
}

/**
 * POST /v1/events/ack, MCP ack_events. An agent's events are acked through
 * agentInboxAck (the same command the owner's app would use); a person's are
 * their own inbox rows, marked read exactly as the app marks them.
 */
export async function ackEvents(
  ctx: ServerCtx,
  a: { ids?: string[] | undefined; upTo?: string | undefined },
): Promise<{ acked: number }> {
  if (isAgentId(ctx.actor)) {
    const res = await invoke(
      'agentInboxAck',
      { agentId: ctx.actor, ...(a.ids ? { ids: a.ids } : { upTo: a.upTo! }) },
      ctx,
      null,
    );
    return { acked: res.acked };
  }
  const boards = new Set((await readableBoards(ctx, { includeArchived: true })).map((b) => b.id));
  const col = db().collection(paths.inbox(ctx.actor));
  let rows: FirebaseFirestore.QueryDocumentSnapshot[] | FirebaseFirestore.DocumentSnapshot[];
  if (a.ids) {
    rows = (
      await db().getAll(...a.ids.filter((id) => !id.includes('/')).map((id) => col.doc(id)))
    ).filter((s) => s.exists);
  } else {
    const cur = decodeCursor<InboxCursor>(a.upTo);
    if (!cur) throw errors.invalid('upTo must be a cursor from GET /v1/events', { field: 'upTo' });
    rows = (
      await col.where('readAt', '==', null).where('createdAt', '<=', cur.c).get()
    ).docs.filter((d) => (d.data() as InboxItem).createdAt < cur.c || d.id <= cur.id);
  }
  const todo = rows.filter((s) => {
    const e = s.data() as InboxItem | undefined;
    return e && e.readAt === null && boards.has(e.boardId);
  });
  for (let i = 0; i < todo.length; i += 400) {
    const batch = db().batch();
    for (const s of todo.slice(i, i + 400)) batch.update(s.ref, { readAt: ctx.now });
    await batch.commit();
  }
  return { acked: todo.length };
}

/** Upload guard shared by REST and MCP: the principal may upload onto this ticket. */
export function requireUpload(ctx: ServerCtx, board: BoardWithId): void {
  requireCan(ctx, board, 'upload', null, null, 'You cannot upload files on this board');
}

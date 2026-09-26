/**
 * ONE IMPLEMENTATION, THREE FRONT DOORS (platform/backend.json
 * proxyFunctions.commands). REST and MCP both land here: translate names to
 * ids (resolve.ts), call THE SAME COMMAND the app calls through runCommand
 * (permission check, validation, transaction, activity, notification and
 * webhook all happen there, once), then map the result with toPublic.
 *
 * There is no API-only write path to drift.
 */
import {
  errors,
  paths,
  parseAttachmentPath,
  type BoardMember,
  type BoardWithId,
  type CommandName,
  type CommandReq,
  type FieldValue,
  type CommandRes,
  type Message,
  type PublicTicket,
  type Ticket,
  type TicketLink,
  type TicketLinkType,
  type TicketWithId,
} from '@tm/shared';
import { can } from '@tm/shared/logic/index';
import { ports } from '../adapters/index.js';
import type { ServerCtx } from '../runtime/context.js';
import { db, isEmulated } from '../runtime/firebase.js';
import { runCommand } from '../runtime/runner.js';
import { loadTicket, withTicketId } from '../tickets/access.js';
import type { StoredMessage } from '@tm/shared';
import { getMessage, recentAndPinned } from '../tickets/read.js';
import { sha256hex } from './crypto.js';
import { boardMembers, toPublicTicket, toPublicTickets } from './public.js';
import {
  actorTz,
  decodeCursor,
  encodeCursor,
  fieldsIn,
  markdownIn,
  parseWhen,
  peopleUids,
  priorityId,
  stageId,
  tagIds,
  ticketByKey,
} from './resolve.js';

/**
 * Run a contract command from a door with a typed input.
 *
 * TOKEN GATE: runtime/runner.ts lets a token reach a command only when the
 * command lists one of its scopes (tokenMayCall — CommandSpec.scopes, any-of;
 * no scopes = app-only). The handler then applies the finer checks
 * (patchScopes, can()).
 */
export function invoke<N extends CommandName>(
  name: N,
  input: CommandReq<N>,
  ctx: ServerCtx,
  idempotencyKey?: string | null,
): Promise<CommandRes<N>> {
  const opts = idempotencyKey === undefined ? {} : { idempotencyKey };
  return runCommand(name, input, ctx, opts) as Promise<CommandRes<N>>;
}

/**
 * An Idempotency-Key header → the key the runner stores (namespaced so a
 * REST key can never collide with an app clientId; hashed so any header
 * value is a safe document id).
 */
export function idemKey(header: string | undefined | null): string | undefined {
  const h = header?.trim();
  if (!h) return undefined;
  if (h.length > 255) throw errors.invalid('Idempotency-Key is too long (max 255)');
  return `ik_${sha256hex(h).slice(0, 40)}`;
}

/** A command-safe clientId (messagePost requires one). */
export const clientIdFor = (key: string | undefined, ctx: ServerCtx): string =>
  key ?? `door_${ctx.ids.id()}`;

// ─── ticket input: the union of REST and MCP spellings ──────────────────────

export interface TicketInput {
  title?: string;
  description_md?: string | null;
  stage?: string;
  priority?: string | null;
  tags?: string[];
  assignees?: string[];
  start_at?: string | null;
  /** ISO instant (REST) or anything parseWhen reads (MCP: '2026-09-24', 'fri'). */
  due?: string | null;
  due_all_day?: boolean;
  estimate?: number | null;
  fields?: Record<string, unknown>;
  links?: { type: TicketLinkType; key: string }[];
}

interface Translated {
  title?: string;
  description?: CommandReq<'ticketCreate'>['description'] | null;
  stageId?: string;
  priorityId?: string | null;
  tagIds?: string[];
  assigneeUids?: string[];
  startAt?: number | null;
  dueAt?: number | null;
  dueAllDay?: boolean;
  estimate?: number | null;
  fields?: Record<string, FieldValue>;
  links?: TicketLink[];
}

async function translate(
  ctx: ServerCtx,
  board: BoardWithId,
  input: TicketInput,
  self?: TicketWithId,
): Promise<Translated> {
  const needPeople =
    !!input.assignees?.length || !!input.fields || !!input.description_md?.includes('@');
  const members: Map<string, BoardMember> = needPeople ? await boardMembers(board.id) : new Map();
  const tz = input.due || input.start_at || input.fields ? await actorTz(ctx) : 'UTC';
  const out: Translated = {};
  if (input.title !== undefined) out.title = input.title;
  if (input.description_md !== undefined)
    out.description =
      input.description_md === null ? null : await markdownIn(input.description_md, board, members);
  if (input.stage !== undefined) out.stageId = stageId(board, input.stage);
  if (input.priority !== undefined) out.priorityId = priorityId(board, input.priority);
  if (input.tags !== undefined) out.tagIds = tagIds(board, input.tags);
  if (input.assignees !== undefined)
    out.assigneeUids = peopleUids(ctx, board, members, input.assignees);
  if (input.start_at !== undefined)
    out.startAt =
      input.start_at === null ? null : parseWhen(input.start_at, ctx.now, tz, 'start').at;
  if (input.due !== undefined) {
    if (input.due === null) out.dueAt = null;
    else {
      const w = parseWhen(input.due, ctx.now, tz, 'due');
      out.dueAt = w.at;
      out.dueAllDay = input.due_all_day ?? w.allDay;
    }
  } else if (input.due_all_day !== undefined) out.dueAllDay = input.due_all_day;
  if (input.estimate !== undefined) out.estimate = input.estimate;
  if (input.fields !== undefined) out.fields = fieldsIn(ctx, board, members, input.fields, tz);
  if (input.links !== undefined) {
    const links: TicketLink[] = [];
    for (const l of input.links) {
      const { ticket } = await ticketByKey(ctx, l.key);
      if (self && ticket.id === self.id) throw errors.invalid('A ticket cannot link to itself');
      links.push({ type: l.type, ticketId: ticket.id });
    }
    out.links = links;
  }
  return out;
}

const drop = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** ticketCreate from outside; answers the public ticket. */
export async function createTicket(
  ctx: ServerCtx,
  board: BoardWithId,
  input: TicketInput & { title: string; attachments?: string[] },
  key?: string,
): Promise<PublicTicket> {
  const t = await translate(ctx, board, input);
  // Files uploaded before the ticket existed carry its future id in their path.
  const ids = new Set((input.attachments ?? []).map((p) => parseAttachmentPath(p)?.ticketId));
  if (ids.size > 1 || ids.has(undefined))
    throw errors.invalid('Attachments must all be uploaded under one ticket folder', {
      field: 'attachments',
    });
  const res = await invoke(
    'ticketCreate',
    drop({
      boardId: board.id,
      ...(ids.size === 1 ? { ticketId: [...ids][0]!, attachments: input.attachments } : {}),
      title: input.title,
      description: t.description ?? undefined,
      stageId: t.stageId,
      priorityId: t.priorityId,
      tagIds: t.tagIds,
      assigneeUids: t.assigneeUids,
      startAt: t.startAt,
      dueAt: t.dueAt,
      dueAllDay: t.dueAllDay,
      estimate: t.estimate,
      fields: t.fields,
    }),
    ctx,
    key ?? null,
  );
  const ticket = await loadTicket(board.id, res.ticketId);
  return toPublicTicket(board, ticket);
}

/** ticketUpdate from outside (fields are MERGED per field by the command). */
export async function updateTicket(
  ctx: ServerCtx,
  board: BoardWithId,
  ticket: TicketWithId,
  input: TicketInput,
  key?: string,
): Promise<PublicTicket> {
  const t = await translate(ctx, board, input, ticket);
  const patch = drop({
    title: t.title,
    description: t.description,
    stageId: t.stageId,
    priorityId: t.priorityId,
    tagIds: t.tagIds,
    assigneeUids: t.assigneeUids,
    startAt: t.startAt,
    dueAt: t.dueAt,
    dueAllDay: t.dueAllDay,
    estimate: t.estimate,
    fields: t.fields,
    links: t.links,
  });
  if (Object.keys(patch).length) {
    await invoke(
      'ticketUpdate',
      { boardId: board.id, ticketId: ticket.id, patch },
      ctx,
      key ?? null,
    );
  }
  return toPublicTicket(board, await loadTicket(board.id, ticket.id));
}

/** Add one link (link_tickets): the command writes the inverse on the other ticket. */
export async function addLink(
  ctx: ServerCtx,
  fromKey: string,
  toKey: string,
  type: TicketLinkType,
): Promise<PublicTicket> {
  const from = await ticketByKey(ctx, fromKey);
  const to = await ticketByKey(ctx, toKey);
  if (from.ticket.id === to.ticket.id) throw errors.invalid('A ticket cannot link to itself');
  const has = from.ticket.links.some((l) => l.ticketId === to.ticket.id && l.type === type);
  if (!has) {
    const links = [
      ...from.ticket.links.filter((l) => l.ticketId !== to.ticket.id),
      { type, ticketId: to.ticket.id },
    ];
    await invoke(
      'ticketUpdate',
      { boardId: from.board.id, ticketId: from.ticket.id, patch: { links } },
      ctx,
      null,
    );
  }
  return toPublicTicket(from.board, await loadTicket(from.board.id, from.ticket.id));
}

/** messagePost from outside with a Markdown body. */
export async function postComment(
  ctx: ServerCtx,
  board: BoardWithId,
  ticket: TicketWithId,
  bodyMd: string,
  attachments: string[] | undefined,
  key?: string,
): Promise<{ id: string; message: Message }> {
  const body = await markdownIn(bodyMd, board);
  const res = await invoke(
    'messagePost',
    drop({
      boardId: board.id,
      ticketId: ticket.id,
      body,
      attachments: attachments?.length ? attachments : undefined,
      clientId: clientIdFor(key, ctx),
    }),
    ctx,
    key ?? null,
  );
  const posted = await getMessage(board.id, ticket.id, res.messageId);
  return { id: res.messageId, message: posted as Message };
}

// ─── reading tickets ─────────────────────────────────────────────────────────

export interface TicketQuery {
  stage?: string;
  assignee?: string;
  q?: string;
  updatedSince?: number;
  state?: Ticket['state'];
  cursor?: string;
  limit: number;
}

interface ListCursor {
  id: string;
  u?: number;
}

/**
 * Tickets on one board, newest-updated first when filtering by time,
 * otherwise in id order (a stable, index-free page order). Text queries go
 * through the search index.
 */
export async function listTickets(
  ctx: ServerCtx,
  board: BoardWithId,
  q: TicketQuery,
): Promise<{ data: PublicTicket[]; next_cursor: string | null }> {
  const members = q.assignee ? await boardMembers(board.id) : undefined;
  const assignee = q.assignee ? peopleUids(ctx, board, members!, [q.assignee])[0]! : undefined;
  const stage = q.stage ? stageId(board, q.stage) : undefined;
  const state = q.state ?? 'active';

  if (q.q) {
    const found = await searchTicketsIn(ctx, [board], q.q, {
      limit: q.limit,
      ...(assignee ? { assignee } : {}),
      state,
    });
    const ts = found.filter(
      (t) => (!stage || t.stageId === stage) && (!q.updatedSince || t.updatedAt >= q.updatedSince),
    );
    return { data: await toPublicTickets(board, ts), next_cursor: null };
  }

  let query = db().collection(paths.tickets(board.id)).where('state', '==', state);
  if (stage) query = query.where('stageId', '==', stage);
  if (assignee) query = query.where('assigneeUids', 'array-contains', assignee);
  const cur = decodeCursor<ListCursor>(q.cursor);
  if (q.updatedSince !== undefined) {
    query = query
      .where('updatedAt', '>=', q.updatedSince)
      .orderBy('updatedAt', 'desc')
      .orderBy('__name__', 'desc');
    if (cur) query = query.startAfter(cur.u ?? 0, cur.id);
  } else {
    query = query.orderBy('__name__');
    if (cur) query = query.startAfter(cur.id);
  }
  const snap = await query.limit(q.limit + 1).get();
  const docs = snap.docs.slice(0, q.limit);
  const ts = docs.map((d) => withTicketId(board.id, d.id, d.data() as Ticket));
  const last = ts[ts.length - 1];
  const next =
    snap.docs.length > q.limit && last
      ? encodeCursor(
          q.updatedSince !== undefined ? { id: last.id, u: last.updatedAt } : { id: last.id },
        )
      : null;
  return { data: await toPublicTickets(board, ts), next_cursor: next };
}

/**
 * Full-text search across boards the caller can read. Typesense in
 * production; under the emulators an empty in-memory index falls back to a
 * title/key scan so dev and tests behave sensibly without the search trigger.
 */
export async function searchTicketsIn(
  ctx: ServerCtx,
  boards: readonly BoardWithId[],
  text: string,
  opts: { limit: number; assignee?: string; state?: Ticket['state'] },
): Promise<TicketWithId[]> {
  const readable = boards.filter((b) => can(ctx, b, 'read'));
  if (!readable.length) return [];
  const { hits } = await ports().search.search({
    q: text,
    boardIds: readable.map((b) => b.id),
    ...(opts.assignee ? { assigneeUids: [opts.assignee] } : {}),
    state: [opts.state ?? 'active'],
    limit: opts.limit,
  });
  if (hits.length) {
    const snaps = await db().getAll(...hits.map((h) => db().doc(paths.ticket(h.boardId, h.id))));
    return snaps
      .filter((s) => s.exists)
      .map((s, i) => withTicketId(hits[i]!.boardId, s.id, s.data() as Ticket));
  }
  if (!isEmulated()) return [];
  const needle = text.trim().toLowerCase();
  const out: TicketWithId[] = [];
  for (const b of readable) {
    let qy = db()
      .collection(paths.tickets(b.id))
      .where('state', '==', opts.state ?? 'active');
    if (opts.assignee) qy = qy.where('assigneeUids', 'array-contains', opts.assignee);
    const snap = await qy.get();
    for (const d of snap.docs) {
      const t = d.data() as Ticket;
      const hay = `${t.key} ${t.title} ${t.description?.text ?? ''}`.toLowerCase();
      if (hay.includes(needle)) out.push(withTicketId(b.id, d.id, t));
    }
  }
  return out.slice(0, opts.limit);
}

/**
 * Last `n` messages of a ticket, oldest first, plus the pinned ones.
 * §W: both come out of the ticket document — one read, not two queries.
 */
export async function recentMessages(
  boardId: string,
  ticketId: string,
  n = 20,
): Promise<{
  recent: { id: string; message: Message }[];
  pinned: { id: string; message: Message }[];
}> {
  const { recent, pinned } = await recentAndPinned(boardId, ticketId, n);
  const map = (m: StoredMessage) => ({ id: m.id, message: m as Message });
  return { recent: recent.map(map), pinned: pinned.map(map) };
}

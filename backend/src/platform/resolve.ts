/**
 * NAMES IN, IDS INSIDE. REST and MCP callers name things the way people do —
 * board key 'ENG', ticket 'ENG-42', stage 'Review', a person's email, a field
 * by its name. This module turns those into the ids the commands take, and
 * when a name does not resolve it says WHICH NAMES EXIST, so a model (or a
 * script author) can correct itself in one step.
 *
 * Visibility is never widened here: every board goes through loadBoard(ctx),
 * which answers 404 for boards the caller (or their token) cannot read.
 */
import {
  COLLECTIONS,
  errors,
  isAgentId,
  paths,
  type BoardKeyClaim,
  type BoardMember,
  type BoardWithId,
  type FieldDef,
  type FieldValue,
  type KeyIndex,
  type RichTextDoc,
  type TicketWithId,
  type User,
} from '@tm/shared';
import { can, collectMarkdownRefs, markdownToDoc, parseDue } from '@tm/shared/logic/index';
import type { ServerCtx } from '../runtime/context.js';
import { db } from '../runtime/firebase.js';
import { loadBoard, loadTicket, withBoardId } from '../tickets/access.js';
import type { Board } from '@tm/shared';
import { boardMembers } from './public.js';

const norm = (s: string) => s.trim().toLowerCase();

/** 400 that lists what does exist. */
export function unknownName(what: string, value: string, options: readonly string[]): never {
  const list = options.length ? options.join(', ') : '(none)';
  throw errors.invalid(`Unknown ${what} "${value}". Available: ${list}`, {
    field: what,
    value,
    options: [...options],
  });
}

// ─── boards ──────────────────────────────────────────────────────────────────

/** Board by key ('ENG', any case) or by id; 404 unless the caller can read it. */
export async function boardByKey(ctx: ServerCtx, keyOrId: string): Promise<BoardWithId> {
  const key = keyOrId.trim().toUpperCase();
  if (/^[A-Z][A-Z0-9]{1,9}$/.test(key)) {
    const claim = await db().doc(paths.boardKey(key)).get();
    if (claim.exists) {
      const c = claim.data() as BoardKeyClaim;
      if (c.deleted) throw errors.not_found('Board not found');
      return loadBoard(ctx, c.boardId);
    }
    // No claim row (seeded / legacy data): look among the caller's own boards.
    const mine = await db()
      .collection(COLLECTIONS.boards)
      .where('readerUids', 'array-contains', ctx.actor)
      .where('key', '==', key)
      .limit(1)
      .get();
    if (mine.docs[0]) return loadBoard(ctx, mine.docs[0].id);
  }
  if (!keyOrId.includes('/')) {
    try {
      return await loadBoard(ctx, keyOrId.trim());
    } catch {
      /* fall through to the friendly 404 */
    }
  }
  throw errors.not_found(`No board "${keyOrId}" that you can see`);
}

/**
 * Every board the caller can read (narrowed by the token's boardIds), by name.
 * A board token names its board(s) outright — and an agent is never in
 * readerUids (agents.html §A) — so those are loaded by id.
 */
export async function readableBoards(
  ctx: ServerCtx,
  opts: { includeArchived?: boolean } = {},
): Promise<BoardWithId[]> {
  const docs = ctx.boardIds
    ? ctx.boardIds.length
      ? (await db().getAll(...ctx.boardIds.map((id) => db().doc(paths.board(id))))).filter(
          (d) => d.exists,
        )
      : []
    : (
        await db()
          .collection(COLLECTIONS.boards)
          .where('readerUids', 'array-contains', ctx.actor)
          .get()
      ).docs;
  return docs
    .map((d) => withBoardId(d.id, d.data() as Board))
    .filter((b) => can(ctx, b, 'read'))
    .filter((b) => opts.includeArchived || b.archivedAt === null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * THE board of a board-scoped request (/v1/board, /v1/tickets, MCP get_board …).
 *
 * A BOARD TOKEN has exactly one; `param` (a board key) may name it again but
 * never another — phase-2 behaviour, unchanged (§R2: "board tokens behave
 * exactly as before"). Credentials spanning several boards — OAuth grants and
 * §R1 ACCOUNT TOKENS — name one, unless they can reach only one, in which
 * case there is nothing to disambiguate and we use it.
 *
 * The board set is read HERE, per request (readableBoards), so an account
 * token that has just lost access to a board cannot name it.
 */
export async function requestBoard(ctx: ServerCtx, param?: string | null): Promise<BoardWithId> {
  if (ctx.boardIds && ctx.boardIds.length === 1) {
    const board = await loadBoard(ctx, ctx.boardIds[0]!);
    if (param && param.trim().toUpperCase() !== board.key && param.trim() !== board.id)
      throw errors.not_found(`This token works on board ${board.key} only`);
    return board;
  }
  if (param) return boardByKey(ctx, param);
  const boards = await readableBoards(ctx);
  if (boards.length === 1) return boards[0]!;
  // §R2: say WHICH boards exist and how to name one — a model (or a script
  // author) can then correct itself in a single step.
  const keys = boards.map((b) => b.key);
  throw errors.invalid(
    keys.length
      ? `This token works on every board you are on, so this call needs a board. Name one of: ${keys.join(', ')}.`
      : 'This token works on every board you are on, but you are not on any board yet.',
    { field: 'board', value: null, options: keys },
  );
}

// ─── tickets ─────────────────────────────────────────────────────────────────

export const TICKET_KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,9}-[1-9][0-9]*$/;

/**
 * Ticket by key through the keys/ index. A deleted ticket's key is kept as a
 * tombstone; it, and a board this credential cannot read, are 404.
 */
export async function ticketByKey(
  ctx: ServerCtx,
  rawKey: string,
): Promise<{ board: BoardWithId; ticket: TicketWithId }> {
  const key = rawKey.trim().replace(/^#/, '').toUpperCase();
  if (!TICKET_KEY_RE.test(key)) throw errors.invalid(`"${rawKey}" is not a ticket key like ENG-42`);
  const snap = await db().doc(paths.key(key)).get();
  const k = snap.exists ? (snap.data() as KeyIndex) : undefined;
  if (!k || k.deleted) throw errors.not_found(`Ticket ${key} not found`);
  const board = await loadBoard(ctx, k.boardId);
  const ticket = await loadTicket(k.boardId, k.ticketId);
  return { board, ticket };
}

/** Keys → ticket ids for Markdown '#KEY' refs (visibility is decided by parseBody later). */
export async function ticketIdsForKeys(keys: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = [...new Set(keys.map((k) => k.toUpperCase()))].filter((k) => TICKET_KEY_RE.test(k));
  if (!list.length) return out;
  const snaps = await db().getAll(...list.map((k) => db().doc(paths.key(k))));
  snaps.forEach((s, i) => {
    const k = s.exists ? (s.data() as KeyIndex) : undefined;
    if (k && !k.deleted) out.set(list[i]!, k.ticketId);
  });
  return out;
}

// ─── board vocabulary ────────────────────────────────────────────────────────

/** Stage by name (case-insensitive) or id. */
export function stageId(board: BoardWithId, s: string): string {
  const hit =
    board.stages.find((x) => x.id === s) ?? board.stages.find((x) => norm(x.name) === norm(s));
  if (!hit)
    unknownName(
      'stage',
      s,
      board.stages.map((x) => x.name),
    );
  return hit.id;
}

export function priorityId(board: BoardWithId, p: string | null): string | null {
  if (p === null || p === '') return null;
  const hit =
    board.priorities.find((x) => x.id === p) ??
    board.priorities.find((x) => norm(x.name) === norm(p));
  if (!hit)
    unknownName(
      'priority',
      p,
      board.priorities.map((x) => x.name),
    );
  return hit.id;
}

export function tagIds(board: BoardWithId, tags: readonly string[]): string[] {
  return tags.map((t) => {
    const hit =
      board.tags.find((x) => x.id === t) ??
      board.tags.find((x) => norm(x.name) === norm(t.replace(/^\+/, '')));
    if (!hit)
      unknownName(
        'tag',
        t,
        board.tags.map((x) => x.name),
      );
    return hit.id;
  });
}

/**
 * A principal on this board, named the way a script or a model names it:
 * 'me' (the token's principal — the agent, for an agent token), an id (uid or
 * 'ag_…'), a person's email, or an AGENT's name (case-insensitive; agents
 * have no email). The error lists what exists: emails and agent names.
 */
export function personUid(
  ctx: ServerCtx,
  board: BoardWithId,
  members: Map<string, BoardMember>,
  who: string,
): string {
  const w = who.trim().replace(/^@/, '');
  if (norm(w) === 'me') return ctx.actor;
  if (board.access[w]) return w;
  const on = [...members.values()].filter((m) => board.access[m.uid]);
  const email = norm(w);
  for (const m of on) if (m.email && norm(m.email) === email) return m.uid;
  const agents = on.filter((m) => m.kind === 'agent' || isAgentId(m.uid));
  const byName = agents.filter((m) => norm(m.name) === email);
  if (byName.length === 1) return byName[0]!.uid;
  if (byName.length > 1)
    throw errors.invalid(`Several agents are called "${who}" — use the id`, {
      field: 'person',
      value: who,
      options: byName.map((m) => m.uid),
    });
  const names = [
    ...on.filter((m) => !(m.kind === 'agent' || isAgentId(m.uid))).map((m) => m.email),
    ...agents.map((m) => `${m.name} (agent)`),
  ];
  return unknownName('person', who, names);
}

export function peopleUids(
  ctx: ServerCtx,
  board: BoardWithId,
  members: Map<string, BoardMember>,
  who: readonly string[],
): string[] {
  return [...new Set(who.map((w) => personUid(ctx, board, members, w)))];
}

/** Field by NAME (case-insensitive) or id. */
export function fieldDef(board: BoardWithId, nameOrId: string): FieldDef {
  const live = board.fields.filter((f) => !f.archived);
  const hit =
    live.find((f) => f.id === nameOrId) ?? live.find((f) => norm(f.name) === norm(nameOrId));
  if (!hit)
    unknownName(
      'field',
      nameOrId,
      live.map((f) => f.name),
    );
  return hit;
}

/** An ISO instant / date (or 'tomorrow', 'fri' …) → millis; all-day for bare dates. */
export function parseWhen(
  s: string,
  now: number,
  tz: string,
  what = 'date',
): { at: number; allDay: boolean } {
  const v = s.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) throw errors.invalid(`Invalid ${what} "${s}"`, { field: what });
    return { at: ms, allDay: false };
  }
  const p = parseDue(v, now, tz);
  if (!p)
    throw errors.invalid(`Invalid ${what} "${s}" — use an ISO date like 2026-09-24`, {
      field: what,
    });
  return p;
}

/** One field value from outside (names, emails, ISO) → the stored shape. */
export function fieldValueIn(
  ctx: ServerCtx,
  board: BoardWithId,
  members: Map<string, BoardMember>,
  def: FieldDef,
  v: unknown,
  tz: string,
): FieldValue {
  if (v === null || v === undefined) return null;
  const opt = (x: unknown) => {
    const s = String(x);
    const o =
      def.options?.find((o) => o.id === s) ?? def.options?.find((o) => norm(o.name) === norm(s));
    if (!o) unknownName(`option of ${def.name}`, s, def.options?.map((o) => o.name) ?? []);
    return o.id;
  };
  const arr = (x: unknown) => (Array.isArray(x) ? x : [x]);
  switch (def.type) {
    case 'select':
      return opt(v);
    case 'multiSelect':
      return arr(v).map(opt);
    case 'person':
      return personUid(ctx, board, members, String(v));
    case 'people':
      return peopleUids(ctx, board, members, arr(v).map(String));
    case 'date':
      return typeof v === 'number' ? v : parseWhen(String(v), ctx.now, tz, def.name).at;
    case 'dateRange': {
      const r = v as { start?: unknown; end?: unknown };
      const t = (x: unknown) =>
        typeof x === 'number' ? x : parseWhen(String(x), ctx.now, tz, def.name).at;
      if (!r || typeof r !== 'object' || r.start === undefined || r.end === undefined)
        throw errors.invalid(`${def.name} needs { start, end }`, { field: def.name });
      return { start: t(r.start), end: t(r.end) };
    }
    default:
      // text, number, checkbox, url … — the command validates the type.
      return v as FieldValue;
  }
}

/** { 'Client': 'Acme' } → { f_abc123: 'Acme' } */
export function fieldsIn(
  ctx: ServerCtx,
  board: BoardWithId,
  members: Map<string, BoardMember>,
  fields: Record<string, unknown>,
  tz: string,
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(fields)) {
    const def = fieldDef(board, k);
    out[def.id] = fieldValueIn(ctx, board, members, def, v, tz);
  }
  return out;
}

/**
 * Markdown from outside → a RichText doc: '@email' / [@Name](mailto:email)
 * become mentions of board members, '#KEY' becomes a ticket ref.
 */
export async function markdownIn(
  md: string,
  board: BoardWithId,
  members?: Map<string, BoardMember>,
): Promise<RichTextDoc> {
  const refs = collectMarkdownRefs(md);
  const m = members ?? (refs.emails.length ? await boardMembers(board.id) : new Map());
  const byEmail = new Map<string, string>();
  for (const x of m.values()) if (board.access[x.uid] && x.email) byEmail.set(norm(x.email), x.uid);
  const keys = await ticketIdsForKeys(refs.keys);
  return markdownToDoc(md, {
    uidForEmail: (e) => byEmail.get(norm(e)),
    // @ag_… / [@Name](agent:ag_…) become mentions only for agents on THIS board.
    agentOnBoard: (id) => isAgentId(id) && !!board.access[id],
    ticketIdForKey: (k) => keys.get(k.toUpperCase()),
  });
}

/** The actor's timezone (for bare dates); UTC when unknown. */
export async function actorTz(ctx: ServerCtx): Promise<string> {
  try {
    const u = await db().doc(paths.user(ctx.actor)).get();
    return (u.data() as User | undefined)?.timezone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A file name safe as one Storage path segment (no slashes, no control characters). */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return name.replace(/[/\\\u0000-\u001f]/g, '_').slice(0, 200) || 'file';
}

// ─── opaque cursors ──────────────────────────────────────────────────────────

export const encodeCursor = (v: unknown): string =>
  Buffer.from(JSON.stringify(v)).toString('base64url');

export function decodeCursor<T>(c: string | undefined): T | null {
  if (!c) return null;
  try {
    return JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as T;
  } catch {
    throw errors.invalid('Invalid cursor', { field: 'cursor' });
  }
}

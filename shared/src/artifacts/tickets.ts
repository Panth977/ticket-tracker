/**
 * §K — a board's tickets as an artifact sees them (BackendDriver.tickets).
 * Pure functions shared by the broker (the host page) and its tests: stored
 * documents → names, Markdown and millis on the way out; names, Markdown and
 * dates → the ticket commands' ids and rich text on the way in.
 *
 * Nothing here decides access. The broker checks the owner's grant (the
 * artifact's `boards`), and the viewer's own session — rules for reads, the
 * ticket commands for writes — decides the rest.
 */
import { errors } from '../errors.js';
import { docToMarkdown, markdownToDoc } from '../logic/richtext/markdown.js';
import type { BoardMember, BoardWithId } from '../schema/board.js';
import type { TicketWithId } from '../schema/ticket.js';
import type { RichTextDoc } from '../types/index.js';
import type {
  DriverBoard,
  DriverPerson,
  DriverTicket,
  TicketInput,
  TicketQuery,
} from './driver.js';
import type { ArtifactBoardAccess } from './schema.js';

export type TicketBoard = Pick<
  BoardWithId,
  'id' | 'key' | 'name' | 'stages' | 'priorities' | 'tags' | 'fields'
>;
type Member = Pick<BoardMember, 'uid' | 'kind' | 'name' | 'email'>;

export const TICKET_LIST_DEFAULT = 200;
export const TICKET_LIST_MAX = 500;

const byPos = <T extends { position: number }>(xs: readonly T[]) =>
  [...xs].sort((a, b) => a.position - b.position);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const toDriverPerson = (m: Member): DriverPerson => ({
  id: m.uid,
  kind: m.kind === 'agent' ? 'agent' : 'user',
  name: m.name,
  email: m.email,
});

export function toDriverBoard(
  board: TicketBoard,
  access: ArtifactBoardAccess,
  canWrite: boolean,
  members: readonly Member[],
): DriverBoard {
  return {
    id: board.id,
    key: board.key,
    name: board.name,
    access,
    canWrite: access === 'write' && canWrite,
    stages: byPos(board.stages).map((s) => ({ id: s.id, name: s.name, category: s.category })),
    priorities: byPos(board.priorities).map((p) => ({ id: p.id, name: p.name })),
    tags: byPos(board.tags).map((t) => ({ id: t.id, name: t.name })),
    fields: byPos(board.fields.filter((f) => !f.archived)).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      ...(f.options ? { options: byPos(f.options).map((o) => o.name) } : {}),
    })),
    members: members.map(toDriverPerson),
  };
}

/** A stored field value → what the page sees (select options by name). */
function fieldOut(board: TicketBoard, fieldId: string, v: unknown): [string, unknown] | null {
  const f = board.fields.find((x) => x.id === fieldId);
  if (!f || f.archived) return null;
  const name = (id: unknown) => f.options?.find((o) => o.id === id)?.name ?? id;
  if (f.type === 'select') return [f.name, v == null ? null : name(v)];
  if (f.type === 'multiSelect') return [f.name, Array.isArray(v) ? v.map(name) : v];
  return [f.name, v];
}

export function toDriverTicket(
  board: TicketBoard,
  t: TicketWithId,
  people: ReadonlyMap<string, DriverPerson>,
  origin: string,
): DriverTicket {
  const stage = board.stages.find((s) => s.id === t.stageId);
  const prio = t.priorityId ? board.priorities.find((p) => p.id === t.priorityId) : undefined;
  const person = (id: string): DriverPerson =>
    people.get(id) ?? { id, kind: id.startsWith('ag_') ? 'agent' : 'user', name: id, email: '' };
  return {
    id: t.id,
    key: t.key,
    board: board.key,
    url: `${origin}/t/${t.key}`,
    title: t.title,
    description: t.description
      ? docToMarkdown(t.description.doc as RichTextDoc, {
          personOf: (uid) => people.get(uid),
        })
      : '',
    stage: {
      id: t.stageId,
      name: stage?.name ?? t.stageId,
      category: stage?.category ?? t.stageCategory,
    },
    priority: prio ? { id: prio.id, name: prio.name } : null,
    tags: t.tagIds.map((id) => board.tags.find((x) => x.id === id)?.name ?? id),
    assignees: t.assigneeUids.map(person),
    state: t.state === 'archived' ? 'archived' : 'active',
    startAt: t.startAt,
    dueAt: t.dueAt,
    fields: Object.fromEntries(
      Object.entries(t.fields ?? {}).flatMap(([id, v]) => {
        const out = fieldOut(board, id, v);
        return out ? [out] : [];
      }),
    ),
    messages: t.counts?.messages ?? 0,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ─── names → ids ────────────────────────────────────────────────────────────

function pick<T extends { id: string; name: string }>(
  list: readonly T[],
  ref: string,
  what: string,
): T {
  const hit = list.find((x) => x.id === ref) ?? list.find((x) => same(x.name, ref));
  if (!hit)
    throw errors.invalid(`Unknown ${what} "${ref}" (have: ${list.map((x) => x.name).join(', ')})`);
  return hit;
}

export const stageRef = (board: TicketBoard, ref: string) =>
  pick(byPos(board.stages), ref, 'stage');

/** 'me' · an email · a person / agent id → a member's id. */
export function personRef(members: readonly Member[], ref: string, me: string): string {
  if (ref === 'me') return me;
  const m =
    members.find((x) => x.uid === ref) ??
    members.find((x) => !!x.email && same(x.email, ref)) ??
    members.find((x) => same(x.name, ref));
  if (!m)
    throw errors.invalid(
      `"${ref}" is not on this board (have: ${members.map((x) => x.email || x.name).join(', ')})`,
    );
  return m.uid;
}

function when(v: number | string | null | undefined, what: string): number | null | undefined {
  if (v === undefined || v === null) return v;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v);
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw errors.invalid(`${what} must be millis or an ISO date, got "${v}"`);
  return t;
}

function fieldIn(board: TicketBoard, ref: string, v: unknown): [string, unknown] {
  const f = pick(
    board.fields.filter((x) => !x.archived),
    ref,
    'field',
  );
  const opt = (name: unknown) =>
    typeof name === 'string' ? pick(f.options ?? [], name, `option of ${f.name}`).id : name;
  if (f.type === 'formula') throw errors.invalid(`${f.name} is computed; it cannot be set`);
  if (f.type === 'select') return [f.id, v == null ? null : opt(v)];
  if (f.type === 'multiSelect')
    return [f.id, Array.isArray(v) ? v.map(opt) : v == null ? [] : [opt(v)]];
  return [f.id, v];
}

/** The ticket commands' fields for a create (title required) or an update (any subset). */
export interface TicketCommandFields {
  title?: string;
  description?: RichTextDoc | null;
  stageId?: string;
  priorityId?: string | null;
  tagIds?: string[];
  assigneeUids?: string[];
  dueAt?: number | null;
  startAt?: number | null;
  fields?: Record<string, unknown>;
}

export function ticketInputToCommand(
  board: TicketBoard,
  members: readonly Member[],
  input: Partial<TicketInput>,
  me: string,
): TicketCommandFields {
  if (!input || typeof input !== 'object') throw errors.invalid('ticket must be an object');
  const out: TicketCommandFields = {};
  const resolveEmail = (email: string) =>
    members.find((m) => m.kind !== 'agent' && same(m.email, email))?.uid;
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim())
      throw errors.invalid('title must be a non-empty string');
    out.title = input.title.trim();
  }
  if (input.description !== undefined)
    out.description = input.description
      ? markdownToDoc(String(input.description), {
          uidForEmail: resolveEmail,
          agentOnBoard: (id) => members.some((m) => m.uid === id),
        })
      : null;
  if (input.stage !== undefined) out.stageId = stageRef(board, String(input.stage)).id;
  if (input.priority !== undefined)
    out.priorityId =
      input.priority === null
        ? null
        : pick(board.priorities, String(input.priority), 'priority').id;
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) throw errors.invalid('tags must be an array');
    out.tagIds = [...new Set(input.tags.map((t) => pick(board.tags, String(t), 'tag').id))];
  }
  if (input.assignees !== undefined) {
    if (!Array.isArray(input.assignees)) throw errors.invalid('assignees must be an array');
    out.assigneeUids = [...new Set(input.assignees.map((a) => personRef(members, String(a), me)))];
  }
  const due = when(input.dueAt, 'dueAt');
  if (due !== undefined) out.dueAt = due;
  const start = when(input.startAt, 'startAt');
  if (start !== undefined) out.startAt = start;
  if (input.fields !== undefined) {
    if (!input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields))
      throw errors.invalid('fields must be an object of name → value');
    out.fields = Object.fromEntries(
      Object.entries(input.fields).map(([k, v]) => fieldIn(board, k, v)),
    );
  }
  return out;
}

// ─── list queries ───────────────────────────────────────────────────────────

/** A query, resolved against the board: what the broker asks Firestore, then filters by. */
export interface TicketPlan {
  state: 'active' | 'archived';
  stageId: string | null;
  /** undefined = anyone, null = unassigned. */
  assignee: string | null | undefined;
  orderBy: NonNullable<TicketQuery['orderBy']>;
  limit: number;
}

export function planTicketQuery(
  board: TicketBoard,
  members: readonly Member[],
  q: TicketQuery | undefined,
  me: string,
): TicketPlan {
  const query = q ?? {};
  if (typeof query !== 'object') throw errors.invalid('query must be an object');
  const state = query.state ?? 'active';
  if (state !== 'active' && state !== 'archived')
    throw errors.invalid("state must be 'active' or 'archived'");
  const orderBy = query.orderBy ?? 'rank';
  if (!['rank', 'updated', 'created', 'due'].includes(orderBy))
    throw errors.invalid("orderBy must be 'rank', 'updated', 'created' or 'due'");
  const limit = Math.min(
    TICKET_LIST_MAX,
    Math.max(1, Math.floor(Number(query.limit ?? TICKET_LIST_DEFAULT)) || TICKET_LIST_DEFAULT),
  );
  return {
    state,
    stageId: query.stage ? stageRef(board, String(query.stage)).id : null,
    assignee:
      query.assignee === undefined
        ? undefined
        : query.assignee === null
          ? null
          : personRef(members, String(query.assignee), me),
    orderBy,
    limit,
  };
}

/** Filter, sort and cut what Firestore answered for (state [+ stage]). */
export function applyTicketPlan(ts: readonly TicketWithId[], plan: TicketPlan): TicketWithId[] {
  const kept = ts.filter(
    (t) =>
      t.state === plan.state &&
      (plan.stageId === null || t.stageId === plan.stageId) &&
      (plan.assignee === undefined ||
        (plan.assignee === null
          ? t.assigneeUids.length === 0
          : t.assigneeUids.includes(plan.assignee))),
  );
  const cmp: Record<TicketPlan['orderBy'], (a: TicketWithId, b: TicketWithId) => number> = {
    rank: (a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0),
    updated: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => b.createdAt - a.createdAt,
    due: (a, b) =>
      (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER) ||
      b.updatedAt - a.updatedAt,
  };
  return kept.sort(cmp[plan.orderBy]).slice(0, plan.limit);
}

/** 'ENG-42' → 'ENG'; null when it is not a ticket key. */
export function boardKeyOfTicketKey(key: string): string | null {
  const m = /^#?([A-Za-z][A-Za-z0-9]{1,9})-\d+$/.exec(String(key).trim());
  return m ? m[1]!.toUpperCase() : null;
}

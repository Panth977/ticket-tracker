/**
 * The view engine — one pure function that turns a board's tickets and a saved
 * View into what a kanban / table / calendar / timeline draws:
 *
 *   applyView(tickets, view, board, ctx) → groups[]
 *     1. includeStates (default ['active'] — archived tickets leave every default view)
 *     2. filter tree   (and / or, every Cmp, tokens me / today / thisWeek / overdue)
 *     3. multi-key sort, ties broken by rank then id (stable across clients)
 *     4. groupBy, then subGroupBy (swimlanes) inside every group
 *
 * Tokens are resolved HERE, at evaluation time, against ctx — so a shared view
 * 'Mine, due this week' means the same thing to everyone who opens it, each in
 * their own time zone.
 *
 * The frontend runs it over the snapshot it already holds; the REST / MCP doors
 * run it on the server over the same tickets. Same function, same answer.
 */
import type { Board, View } from '../schema/board.js';
import type { TicketWithId } from '../schema/ticket.js';
import {
  isFilterGroup,
  TICKET_STATES,
  type FieldDef,
  type FilterLeaf,
  type FilterNode,
  type Millis,
  type Option,
  type TicketState,
  type Uid,
} from '../types/index.js';
import { compareRank } from './rank.js';
import { dayRange, isOverdue, weekRange, type Range } from './time.js';

// ───────────────────────── inputs ─────────────────────────

/** The ticket fields the engine reads — a full TicketWithId satisfies it. */
export type ViewTicket = Pick<
  TicketWithId,
  | 'id'
  | 'key'
  | 'number'
  | 'title'
  | 'stageId'
  | 'stageCategory'
  | 'priorityId'
  | 'tagIds'
  | 'state'
  | 'rank'
  | 'assigneeUids'
  | 'startAt'
  | 'dueAt'
  | 'dueAllDay'
  | 'estimate'
  | 'fields'
  | 'links'
  | 'createdBy'
  | 'createdAt'
  | 'updatedAt'
> &
  Partial<
    Pick<TicketWithId, 'description' | 'refs' | 'referencedBy' | 'lastActivityAt' | 'completedAt'>
  >;

export type ViewSpec = Partial<
  Pick<View, 'filter' | 'sort' | 'groupBy' | 'subGroupBy' | 'includeStates'>
>;
export type ViewBoard = Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields'>;

export interface ViewCtx {
  /** Resolves the 'me' token. */
  me: Uid;
  now: Millis;
  /** IANA zone — what 'today' and 'thisWeek' mean. */
  tz: string;
  /** 1 = Monday (default), 0 = Sunday. */
  weekStartsOn?: number;
}

export const DEFAULT_INCLUDE_STATES: readonly TicketState[] = ['active'];
/** Group key for 'no value' (no priority, unassigned, untagged, empty field). */
export const NONE_KEY = '__none__';
/** Group key when the view is not grouped. */
export const ALL_KEY = '__all__';

export interface ViewGroup<T> {
  /** Stable key: stage / option id, uid, 'true' / 'false', the value, or NONE_KEY / ALL_KEY. */
  key: string;
  /** The field this level groups by (null for the single ungrouped group). */
  by: string | null;
  /** The raw value (null for NONE / ALL). */
  value: string | number | boolean | null;
  /** Stage or option name; null where the UI resolves it (people) or for NONE / ALL. */
  label: string | null;
  color?: string | undefined;
  tickets: T[];
  /** Swimlanes — present when the view has subGroupBy. Every group carries the same lanes, in the same order. */
  subGroups?: ViewGroup<T>[];
}

// ───────────────────────── field access ─────────────────────────

type Kind = 'set' | 'scalar' | 'number' | 'date' | 'text';
type Raw = string | number | boolean | null | undefined | readonly string[];
interface Accessor<T> {
  kind: Kind;
  get: (t: T) => Raw;
  /** For 'set' / 'scalar' fields whose values are options with a board order. */
  options?: Option[];
  def?: FieldDef;
}

const byPosition = <X extends { position: number }>(xs: readonly X[]): X[] =>
  [...xs].sort((a, b) => a.position - b.position);

function fieldDef(board: ViewBoard, field: string): FieldDef | undefined {
  if (!field.startsWith('fields.')) return undefined;
  const id = field.slice('fields.'.length);
  return board.fields.find((f) => f.id === id);
}

function customAccessor<T extends ViewTicket>(def: FieldDef): Accessor<T> {
  const raw = (t: T) => t.fields[def.id];
  switch (def.type) {
    case 'multiSelect':
    case 'people':
    case 'ticketRelation':
      return {
        kind: 'set',
        get: (t) => asStrings(raw(t)),
        options: def.type === 'multiSelect' ? byPosition(def.options ?? []) : undefined,
        def,
      };
    case 'number':
    case 'currency':
    case 'percent':
    case 'rating':
    case 'formula':
      return { kind: 'number', get: (t) => asNumber(raw(t)), def };
    case 'date':
      return { kind: 'date', get: (t) => asNumber(raw(t)), def };
    case 'dateRange':
      return {
        kind: 'date',
        get: (t) => {
          const v = raw(t);
          return v && typeof v === 'object' && !Array.isArray(v) ? v.start : null;
        },
        def,
      };
    case 'checkbox':
      return { kind: 'scalar', get: (t) => raw(t) === true, def };
    case 'select':
      return {
        kind: 'scalar',
        get: (t) => asScalar(raw(t)),
        options: byPosition(def.options ?? []),
        def,
      };
    default:
      // text, longText, url, email, phone, person
      return { kind: 'scalar', get: (t) => asScalar(raw(t)), def };
  }
}

const asStrings = (v: unknown): readonly string[] => (Array.isArray(v) ? (v as string[]) : []);
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const asScalar = (v: unknown): string | number | boolean | null =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;

/** How the engine reads `field` off a ticket; null for a field it does not know. */
export function accessor<T extends ViewTicket>(
  board: ViewBoard,
  field: string,
): Accessor<T> | null {
  switch (field) {
    case 'stage':
      return { kind: 'scalar', get: (t) => t.stageId, options: byPosition(board.stages) };
    case 'priority':
      return { kind: 'scalar', get: (t) => t.priorityId, options: byPosition(board.priorities) };
    case 'assignee':
      return { kind: 'set', get: (t) => t.assigneeUids };
    case 'tag':
      return { kind: 'set', get: (t) => t.tagIds, options: byPosition(board.tags) };
    case 'due':
      return { kind: 'date', get: (t) => t.dueAt };
    case 'start':
      return { kind: 'date', get: (t) => t.startAt };
    case 'createdAt':
    case 'created':
      return { kind: 'date', get: (t) => t.createdAt };
    case 'updatedAt':
    case 'updated':
      return { kind: 'date', get: (t) => t.updatedAt };
    case 'lastActivityAt':
      return { kind: 'date', get: (t) => t.lastActivityAt ?? t.updatedAt };
    case 'completedAt':
      return { kind: 'date', get: (t) => t.completedAt ?? null };
    case 'state':
      return { kind: 'scalar', get: (t) => t.state };
    case 'stageCategory':
      return { kind: 'scalar', get: (t) => t.stageCategory };
    case 'createdBy':
      return { kind: 'scalar', get: (t) => t.createdBy };
    case 'estimate':
      return { kind: 'number', get: (t) => t.estimate };
    case 'number':
    case 'key':
      return { kind: 'number', get: (t) => t.number };
    case 'title':
      return { kind: 'scalar', get: (t) => t.title };
    case 'rank':
      return { kind: 'scalar', get: (t) => t.rank };
    case 'text':
      return {
        kind: 'text',
        get: (t) => `${t.key}\n${t.title}\n${t.description?.text ?? ''}`,
      };
    case 'linked':
      // Any relation at all: explicit links (both directions) and #references either way.
      return {
        kind: 'set',
        get: (t) => [
          ...new Set([
            ...t.links.map((l) => l.ticketId),
            ...(t.refs ?? []),
            ...(t.referencedBy ?? []),
          ]),
        ],
      };
    default: {
      const def = fieldDef(board, field);
      return def ? customAccessor<T>(def) : null;
    }
  }
}

// ───────────────────────── filter ─────────────────────────

interface Env {
  board: ViewBoard;
  ctx: ViewCtx;
  today: Range;
  week: Range;
}

const isEmpty = (v: Raw): boolean =>
  v == null || v === '' || v === false || (Array.isArray(v) && v.length === 0);

/** 'me' → ctx.me, recursively through arrays. Date tokens stay for the date comparator. */
function resolveMe(v: unknown, env: Env): unknown {
  if (v === 'me') return env.ctx.me;
  if (Array.isArray(v)) return v.map((x) => resolveMe(x, env));
  return v;
}

const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);

/** A date operand: a token → its range; millis → that instant; a 'YYYY-MM-DD' string → that local day. */
function dateOperand(v: unknown, env: Env): Range | number | 'overdue' | null {
  if (v === 'today') return env.today;
  if (v === 'thisWeek') return env.week;
  if (v === 'overdue') return 'overdue';
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const ms = Date.parse(v.length === 10 ? `${v}T12:00:00Z` : v);
    if (Number.isNaN(ms)) return null;
    return v.length === 10 ? dayRange(ms, env.ctx.tz) : ms;
  }
  return null;
}

function evalDate(
  t: ViewTicket,
  field: string,
  d: number | null,
  leaf: FilterLeaf,
  env: Env,
): boolean {
  const { cmp } = leaf;
  if (cmp === 'empty') return d == null;
  if (cmp === 'notEmpty') return d != null;

  const overdue = () =>
    field === 'due' &&
    t.stageCategory !== 'done' &&
    t.stageCategory !== 'cancelled' &&
    isOverdue(t.dueAt, env.ctx.now, { allDay: t.dueAllDay, tz: env.ctx.tz });

  const is = (v: unknown): boolean => {
    const op = dateOperand(v, env);
    if (op === 'overdue') return overdue();
    if (d == null || op == null) return false;
    if (typeof op === 'number') {
      const r = dayRange(op, env.ctx.tz); // 'is <instant>' = same local day
      return d >= r.start && d < r.end;
    }
    return d >= op.start && d < op.end;
  };

  switch (cmp) {
    case 'is':
      return is(leaf.value);
    case 'isNot':
      return !is(leaf.value);
    case 'in':
      return Array.isArray(leaf.value) && leaf.value.some(is);
    case 'notIn':
      return !(Array.isArray(leaf.value) && leaf.value.some(is));
    case 'before':
    case 'lt': {
      const op = dateOperand(leaf.value, env);
      if (d == null || op == null) return false;
      if (op === 'overdue') return overdue();
      return d < (typeof op === 'number' ? op : op.start);
    }
    case 'after':
    case 'gt': {
      const op = dateOperand(leaf.value, env);
      if (d == null || op == null || op === 'overdue') return false;
      return typeof op === 'number' ? d > op : d >= op.end;
    }
    case 'between': {
      if (d == null || !Array.isArray(leaf.value) || leaf.value.length !== 2) return false;
      const lo = dateOperand(leaf.value[0], env);
      const hi = dateOperand(leaf.value[1], env);
      if (lo == null || hi == null || lo === 'overdue' || hi === 'overdue') return false;
      const start = typeof lo === 'number' ? lo : lo.start;
      // A range upper bound is exclusive (end of that day / week); an instant is inclusive.
      return d >= start && (typeof hi === 'number' ? d <= hi : d < hi.end);
    }
    case 'contains':
      return false;
  }
}

function evalLeaf<T extends ViewTicket>(t: T, leaf: FilterLeaf, env: Env): boolean {
  const acc = accessor<T>(env.board, leaf.field);
  if (!acc) return false; // an unknown / deleted field matches nothing
  const raw = acc.get(t);

  if (acc.kind === 'date')
    return evalDate(t, leaf.field, (raw as number | null) ?? null, leaf, env);
  if (leaf.cmp === 'empty') return isEmpty(raw);
  if (leaf.cmp === 'notEmpty') return !isEmpty(raw);

  const value = resolveMe(leaf.value, env);
  const values: unknown[] = Array.isArray(value) ? value : [value];

  if (acc.kind === 'text') {
    const hay = String(raw).toLowerCase();
    const needle = typeof value === 'string' ? value.trim().toLowerCase() : '';
    const hit = needle === '' || hay.includes(needle);
    return leaf.cmp === 'isNot' || leaf.cmp === 'notIn'
      ? !hit
      : leaf.cmp === 'contains' || leaf.cmp === 'is' || leaf.cmp === 'in'
        ? hit
        : false;
  }

  if (acc.kind === 'set') {
    const set = raw as readonly string[];
    const has = (v: unknown) => set.includes(v as string);
    switch (leaf.cmp) {
      case 'is':
      case 'contains':
        return values.every(has);
      case 'isNot':
        return !values.every(has);
      case 'in':
        return values.some(has);
      case 'notIn':
        return !values.some(has);
      default:
        return false;
    }
  }

  // scalar / number
  const eq = (v: unknown) => (acc.kind === 'number' ? raw === Number(v) : lower(raw) === lower(v));
  const num = acc.kind === 'number' ? (raw as number | null) : null;
  switch (leaf.cmp) {
    case 'is':
      return eq(value);
    case 'isNot':
      return !eq(value);
    case 'in':
      return values.some(eq);
    case 'notIn':
      return !values.some(eq);
    case 'contains':
      return (
        raw != null &&
        typeof value === 'string' &&
        String(raw).toLowerCase().includes(value.toLowerCase())
      );
    case 'lt':
    case 'before':
      if (num != null) return num < Number(value);
      return typeof raw === 'string' && typeof value === 'string' && raw < value;
    case 'gt':
    case 'after':
      if (num != null) return num > Number(value);
      return typeof raw === 'string' && typeof value === 'string' && raw > value;
    case 'between': {
      if (num == null || !Array.isArray(value) || value.length !== 2) return false;
      return num >= Number(value[0]) && num <= Number(value[1]);
    }
  }
  return false;
}

function evalNode<T extends ViewTicket>(t: T, node: FilterNode, env: Env): boolean {
  if (isFilterGroup(node)) {
    // An empty group constrains nothing.
    if (node.children.length === 0) return true;
    return node.op === 'and'
      ? node.children.every((c) => evalNode(t, c, env))
      : node.children.some((c) => evalNode(t, c, env));
  }
  return evalLeaf(t, node, env);
}

function makeEnv(board: ViewBoard, ctx: ViewCtx): Env {
  return {
    board,
    ctx,
    today: dayRange(ctx.now, ctx.tz),
    week: weekRange(ctx.now, ctx.tz, ctx.weekStartsOn ?? 1),
  };
}

/** Does one ticket pass a filter tree? (null filter = everything.) */
export function matchesFilter<T extends ViewTicket>(
  t: T,
  filter: FilterNode | null | undefined,
  board: ViewBoard,
  ctx: ViewCtx,
): boolean {
  return !filter || evalNode(t, filter, makeEnv(board, ctx));
}

// ───────────────────────── sort ─────────────────────────

type SortKey = { field: string; dir: 'asc' | 'desc' };

function sortValue<T extends ViewTicket>(acc: Accessor<T>, t: T): string | number | null {
  const raw = acc.get(t);
  if (acc.options) {
    // Option-valued: order by the board's position, not by id.
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (first == null) return null;
    const i = acc.options.findIndex((o) => o.id === first);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  }
  if (Array.isArray(raw)) return raw.length ? [...raw].sort()[0]! : null;
  if (raw == null || raw === '') return null;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  return raw as string | number;
}

function cmpValues(a: string | number, b: string | number, field: string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (field === 'rank') return compareRank(String(a), String(b));
  return String(a).localeCompare(String(b), 'en', { sensitivity: 'base', numeric: true });
}

/**
 * Sort by several keys. Empty values sort LAST whichever the direction; ties
 * fall back to rank, then id, so every client shows the same order.
 */
export function sortTickets<T extends ViewTicket>(
  tickets: readonly T[],
  sort: readonly SortKey[] | undefined,
  board: ViewBoard,
): T[] {
  const keys = (sort ?? [])
    .map((s) => ({ ...s, acc: accessor<T>(board, s.field) }))
    .filter((k): k is SortKey & { acc: Accessor<T> } => k.acc != null);
  const decorated = tickets.map((t) => ({ t, vs: keys.map((k) => sortValue(k.acc, t)) }));
  decorated.sort((x, y) => {
    for (let i = 0; i < keys.length; i++) {
      const a = x.vs[i];
      const b = y.vs[i];
      if (a == null && b == null) continue;
      if (a == null) return 1;
      if (b == null) return -1;
      const c = cmpValues(a, b, keys[i]!.field);
      if (c !== 0) return keys[i]!.dir === 'desc' ? -c : c;
    }
    return compareRank(x.t.rank, y.t.rank) || compareRank(x.t.id, y.t.id);
  });
  return decorated.map((d) => d.t);
}

// ───────────────────────── group ─────────────────────────

interface Bucket {
  key: string;
  value: string | number | boolean | null;
  label: string | null;
  color?: string | undefined;
}
interface Dimension<T> {
  /** The buckets to show, in order (may include empty ones). */
  buckets: Bucket[];
  /** Which bucket keys one ticket falls in (a multi-valued field → several). */
  keysOf: (t: T) => string[];
  /** Keep the NONE bucket even when empty — a drop target for 'clear priority'. */
  keepEmptyNone: boolean;
}

const NONE: Bucket = { key: NONE_KEY, value: null, label: null };

function dimension<T extends ViewTicket>(
  by: string,
  board: ViewBoard,
  tickets: readonly T[],
  ctx: ViewCtx,
): Dimension<T> | null {
  if (by === 'state') {
    return {
      buckets: TICKET_STATES.map((s) => ({ key: s, value: s, label: s })),
      keysOf: (t) => [t.state],
      keepEmptyNone: false,
    };
  }
  const acc = accessor<T>(board, by);
  if (!acc) return null;
  const valuesOf = (t: T): string[] => {
    const raw = acc.get(t);
    if (Array.isArray(raw)) return raw.length ? raw.map(String) : [];
    if (raw == null || raw === '') return [];
    return [String(raw)];
  };

  // 1. Option-valued (stage, priority, tag, select, multiSelect): the board's
  //    options in order, EMPTY ONES INCLUDED — a kanban column is a drop target.
  if (acc.options) {
    const known = new Set(acc.options.map((o) => o.id));
    const buckets: Bucket[] = acc.options.map((o) => ({
      key: o.id,
      value: o.id,
      label: o.name,
      color: 'color' in o ? (o as { color?: string }).color : undefined,
    }));
    const keysOf = (t: T) => {
      const ks = valuesOf(t).filter((v) => known.has(v));
      return ks.length ? ks : [NONE_KEY]; // no value, or a deleted option
    };
    // 'No stage' only appears when something is actually orphaned; the others always offer 'none'.
    return { buckets: [...buckets, NONE], keysOf, keepEmptyNone: by !== 'stage' };
  }

  // 2. Checkbox: checked, then not.
  if (acc.def?.type === 'checkbox') {
    return {
      buckets: [
        { key: 'true', value: true, label: null },
        { key: 'false', value: false, label: null },
      ],
      keysOf: (t) => [acc.get(t) === true ? 'true' : 'false'],
      keepEmptyNone: false,
    };
  }

  // 3. Open-valued (assignee, people, person, createdBy, text, number, date …):
  //    one bucket per value present, 'none' last. People: me first, then by uid
  //    (the UI re-orders by display name, which the engine does not have).
  const seen = new Map<string, string | number | boolean>();
  for (const t of tickets) {
    const raw = acc.get(t);
    const vals = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw];
    for (const v of vals) seen.set(String(v), v as string | number | boolean);
  }
  const isPeople =
    by === 'assignee' ||
    by === 'createdBy' ||
    acc.def?.type === 'person' ||
    acc.def?.type === 'people';
  const entries = [...seen.entries()].sort(([ka, a], [kb, b]) => {
    if (isPeople) {
      if (ka === ctx.me) return -1;
      if (kb === ctx.me) return 1;
    }
    return typeof a === 'number' && typeof b === 'number'
      ? a - b
      : ka.localeCompare(kb, 'en', { numeric: true });
  });
  return {
    buckets: [...entries.map(([key, value]) => ({ key, value, label: null })), NONE],
    keysOf: (t) => {
      const vs = valuesOf(t);
      return vs.length ? vs : [NONE_KEY];
    },
    keepEmptyNone: false,
  };
}

function bucketize<T extends ViewTicket>(
  tickets: readonly T[],
  by: string,
  dim: Dimension<T>,
): ViewGroup<T>[] {
  const groups = new Map<string, ViewGroup<T>>(
    dim.buckets.map((b) => [b.key, { ...b, by, tickets: [] as T[] }]),
  );
  for (const t of tickets) {
    for (const k of dim.keysOf(t)) groups.get(k)?.tickets.push(t);
  }
  return [...groups.values()].filter(
    (g) => g.key !== NONE_KEY || g.tickets.length > 0 || dim.keepEmptyNone,
  );
}

/**
 * THE ENGINE. Returns groups in display order; tickets inside each group (and
 * each swimlane) are already sorted. A ticket with several values for the
 * grouping field (two assignees, three tags) appears in each of their groups.
 */
export function applyView<T extends ViewTicket>(
  tickets: readonly T[],
  view: ViewSpec,
  board: ViewBoard,
  ctx: ViewCtx,
): ViewGroup<T>[] {
  const states = view.includeStates?.length ? view.includeStates : DEFAULT_INCLUDE_STATES;
  const env = makeEnv(board, ctx);
  const visible = tickets.filter(
    (t) => states.includes(t.state) && (!view.filter || evalNode(t, view.filter, env)),
  );
  const sorted = sortTickets(visible, view.sort, board);

  const groupDim = view.groupBy ? dimension(view.groupBy, board, sorted, ctx) : null;
  const groups: ViewGroup<T>[] = groupDim
    ? bucketize(sorted, view.groupBy!, groupDim)
    : [{ key: ALL_KEY, by: null, value: null, label: null, tickets: sorted }];

  if (view.subGroupBy) {
    // Lanes are computed over ALL visible tickets so every column has the same rows.
    const laneDim = dimension(view.subGroupBy, board, sorted, ctx);
    if (laneDim) {
      const laneKeys = new Set(bucketize(sorted, view.subGroupBy, laneDim).map((l) => l.key));
      const lanes = { ...laneDim, buckets: laneDim.buckets.filter((b) => laneKeys.has(b.key)) };
      for (const g of groups) {
        const byKey = new Map(
          lanes.buckets.map((b) => [b.key, { ...b, by: view.subGroupBy!, tickets: [] as T[] }]),
        );
        for (const t of g.tickets) for (const k of lanes.keysOf(t)) byKey.get(k)?.tickets.push(t);
        g.subGroups = [...byKey.values()];
      }
    }
  }
  return groups;
}

/** Just the flat, filtered, sorted list (table view, exports, REST list). */
export function applyViewFlat<T extends ViewTicket>(
  tickets: readonly T[],
  view: ViewSpec,
  board: ViewBoard,
  ctx: ViewCtx,
): T[] {
  return applyView(tickets, { ...view, groupBy: null, subGroupBy: null }, board, ctx)[0]!.tickets;
}

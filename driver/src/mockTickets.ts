/**
 * The mock's §K board: one 'DEMO' board granted 'write', a handful of tickets
 * with threads (comments, a system line, an answered question, turn receipts,
 * aggregate entries, an attachment, a tombstone) and the aggregate fields
 * Cost ($, daily) and Time (h, weekly) — buckets computed from those entries —
 * kept with the rest of the mock state so a reload keeps them. Lightweight on
 * purpose — the real converters (@tm/shared/artifacts/tickets) pull in the
 * Markdown editor's parser, which has no place in the driver bundle — so it
 * resolves names the simple way and keeps descriptions as the Markdown given.
 */
import type {
  AggregateQuery,
  DriverAggBucket,
  DriverAggCounter,
  DriverAggField,
  DriverAggregates,
  DriverAttachment,
  DriverBoard,
  DriverMessage,
  DriverPerson,
  DriverTicket,
  ThreadQuery,
  TicketInput,
  TicketQuery,
} from '@tm/shared/artifacts/driver';
import { fail } from './transport.js';

export interface MockTicketState {
  tickets: DriverTicket[];
  seq: number;
  /** Ticket key → its thread, oldest first. */
  threads: Record<string, DriverMessage[]>;
}

const ME: DriverPerson = {
  id: 'mock-user',
  kind: 'user',
  name: 'You (mock)',
  email: 'you@example.com',
};
const ALEX: DriverPerson = {
  id: 'mock-alex',
  kind: 'user',
  name: 'Alex',
  email: 'alex@example.com',
};
const BOT: DriverPerson = { id: 'ag_mockbuilder00000', kind: 'agent', name: 'Builder', email: '' };

export const MOCK_BOARD: DriverBoard = {
  id: 'mock-board',
  key: 'DEMO',
  name: 'Demo board (mock)',
  access: 'write',
  canWrite: true,
  stages: [
    { id: 's_todo', name: 'To do', category: 'todo' },
    { id: 's_doing', name: 'Doing', category: 'active' },
    { id: 's_done', name: 'Done', category: 'done' },
  ],
  priorities: [
    { id: 'p_high', name: 'High' },
    { id: 'p_low', name: 'Low' },
  ],
  tags: [
    { id: 't_bug', name: 'bug' },
    { id: 't_ui', name: 'ui' },
  ],
  fields: [{ id: 'f_points', name: 'Points', type: 'number' }],
  members: [ME, ALEX, BOT],
  aggFields: [
    { id: 'cost', label: 'Cost', unit: '$', period: 'daily', archived: false },
    { id: 'a_hours0', label: 'Time', unit: 'h', period: 'weekly', archived: false },
  ],
  aggs: {},
};

const DAY = 86_400_000;

export function seedTickets(now = Date.now()): MockTicketState {
  const t = (
    n: number,
    title: string,
    stage: number,
    who: DriverPerson[],
    due: number | null,
    prio: number | null,
  ): DriverTicket => ({
    id: `mock-t${n}`,
    key: `DEMO-${n}`,
    board: 'DEMO',
    url: `https://example.invalid/t/DEMO-${n}`,
    title,
    description: '',
    stage: MOCK_BOARD.stages[stage]!,
    priority: prio === null ? null : MOCK_BOARD.priorities[prio]!,
    tags: [],
    assignees: who,
    state: 'active',
    startAt: null,
    dueAt: due === null ? null : now + due * DAY,
    fields: { Points: n },
    messages: 0,
    aggs: {},
    createdAt: now - (10 - n) * DAY,
    updatedAt: now - n * 3_600_000,
  });
  const s: MockTicketState = {
    seq: 5,
    tickets: [
      t(1, 'Sketch the dashboard', 2, [ME], -3, null),
      t(2, 'Wire the numbers', 1, [ME, BOT], 1, 0),
      t(3, 'Fix the chart colours', 0, [ALEX], 4, 1),
      t(4, 'Ask for feedback', 0, [], null, null),
      t(5, 'Ship it', 0, [ME], 7, 0),
    ],
    threads: seedThreads(now),
  };
  for (const tk of s.tickets) {
    tk.messages = s.threads[tk.key]?.length ?? 0;
    tk.aggs = ticketAggs(s, tk.key);
  }
  return s;
}

// ─── threads ────────────────────────────────────────────────────────────────

const SYSTEM: DriverPerson = { id: '', kind: 'user', name: 'TaskManager', email: '' };
export const MOCK_FILE: DriverAttachment = {
  id: 'mock-file-1',
  name: 'notes.txt',
  mime: 'text/plain',
  size: 42,
};
let mseq = 0;
const msg = (
  at: number,
  author: DriverPerson,
  markdown: string,
  o: Partial<DriverMessage> = {},
): DriverMessage => ({
  id: `mock-m${++mseq}`,
  kind: 'comment',
  author,
  markdown,
  createdAt: at,
  editedAt: null,
  deleted: false,
  replyTo: null,
  pinned: false,
  attachments: [],
  ...o,
});
const entry = (fieldId: string, value: number) => {
  const f = MOCK_BOARD.aggFields.find((x) => x.id === fieldId)!;
  return { fieldId, label: f.label, unit: f.unit, value };
};

function seedThreads(now: number): Record<string, DriverMessage[]> {
  mseq = 0;
  const H = 3_600_000;
  const at = (days: number, hours = 0) => now - days * DAY + hours * H;
  const th: Record<string, DriverMessage[]> = {};
  const add = (key: string, m: DriverMessage) => (th[key] ??= []).push(m);
  // A month of agent turns (cost, daily) and logged hours (time, weekly) across the board.
  for (let d = 27; d >= 0; d--) {
    if (d % 4 !== 3) {
      const cost = (((d * 37) % 90) + 10) / 100;
      add(
        `DEMO-${(d % 3) + 1}`,
        msg(at(d, -3), BOT, `Turn ${28 - d} · review · $${cost.toFixed(2)}`, {
          run: {
            n: 28 - d,
            outcome: 'review',
            costUsd: cost,
            durationMs: (d + 3) * 60_000,
            model: 'claude-sonnet',
          },
          agg: { entries: [entry('cost', cost)] },
        }),
      );
    }
    if (d % 4 === 0)
      add(
        `DEMO-${(d % 5) + 1}`,
        msg(at(d, -5), d % 8 ? ALEX : ME, '', {
          kind: 'agg',
          agg: { entries: [entry('a_hours0', ((d % 4) + 1) * 0.5 + (d % 3))] },
        }),
      );
  }
  const k = 'DEMO-2';
  const ask = msg(at(5), ALEX, 'Can we show **cost per day** on the dashboard?');
  add(k, ask);
  add(k, msg(at(5, 1), SYSTEM, 'Alex moved this to Doing', { kind: 'system' }));
  add(
    k,
    msg(at(4), BOT, 'Which chart should the dashboard use?', {
      kind: 'question',
      question: {
        title: 'Which chart should the dashboard use?',
        status: 'answered',
        blocking: true,
        fields: [
          {
            id: 'f_chart',
            label: 'Chart',
            type: 'single',
            required: true,
            options: ['Bars', 'Line'],
          },
        ],
        answer: { values: { Chart: 'Bars' }, comment: null, by: ME, at: at(4, 2) },
      },
    }),
  );
  add(
    k,
    msg(at(1), ALEX, 'Notes from the review attached.', {
      replyTo: ask.id,
      attachments: [MOCK_FILE],
      pinned: true,
    }),
  );
  add(k, msg(at(0, -2), ALEX, '', { deleted: true }));
  for (const list of Object.values(th)) list.sort((a, b) => a.createdAt - b.createdAt);
  return th;
}

/** tickets.thread: the newest `limit` (default 50, ≤ 200) before `before` (an id or millis), oldest first. */
export function threadOf(
  s: MockTicketState,
  key: unknown,
  q: ThreadQuery | undefined,
): DriverMessage[] {
  const t = ticketByKey(s, key) ?? fail('not-found', `No ticket ${String(key)}`);
  const query = q ?? {};
  const limit = Math.min(200, Math.max(1, Math.floor(Number(query.limit ?? 50)) || 50));
  let rows = s.threads[t.key] ?? [];
  const b = query.before;
  if (typeof b === 'number') rows = rows.filter((m) => m.createdAt < b);
  else if (typeof b === 'string') {
    const i = rows.findIndex((m) => m.id === b);
    if (i < 0) fail('not-found', `No message ${b} on this ticket`);
    rows = rows.slice(0, i);
  } else if (b != null) fail('invalid-argument', 'before must be a message id or a time in millis');
  return structuredCloneSafe(rows.slice(Math.max(0, rows.length - limit)));
}

/** An attachment of the ticket's thread, by id. */
export function ticketFile(s: MockTicketState, key: unknown, file: unknown): DriverAttachment {
  const t = ticketByKey(s, key) ?? fail('not-found', `No ticket ${String(key)}`);
  return (
    (s.threads[t.key] ?? []).flatMap((m) => m.attachments).find((a) => a.id === file) ??
    fail('not-found', `No file ${String(file)} on ${t.key}`)
  );
}

// ─── aggregates ─────────────────────────────────────────────────────────────

const p2 = (n: number) => String(n).padStart(2, '0');
/** Period keys, cut in UTC here (the real buckets use the board owner's zone). */
function periodKey(p: DriverAggField['period'], ms: number): string {
  const d = new Date(ms);
  const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  if (p === 'daily') return `${y}-${p2(m)}-${p2(day)}`;
  if (p === 'monthly') return `${y}-${p2(m)}`;
  const t = new Date(Date.UTC(y, m - 1, day));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yy = t.getUTCFullYear();
  return `${yy}-W${p2(Math.ceil(((t.getTime() - Date.UTC(yy, 0, 1)) / DAY + 1) / 7))}`;
}
const KEY_RE = { daily: /^\d{4}-\d{2}-\d{2}$/, weekly: /^\d{4}-W\d{2}$/, monthly: /^\d{4}-\d{2}$/ };
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const bump = (c: DriverAggCounter | undefined, v: number): DriverAggCounter => ({
  total: round((c?.total ?? 0) + v),
  count: (c?.count ?? 0) + 1,
});

/** Every live entry: [ticket key, field id, value, when]. */
function entries(s: MockTicketState): [string, string, number, number][] {
  return Object.entries(s.threads).flatMap(([key, ms]) =>
    ms.flatMap((m) =>
      m.agg && !m.deleted
        ? m.agg.entries.map((e): [string, string, number, number] => [
            key,
            e.fieldId,
            e.value,
            m.agg!.at ?? m.createdAt,
          ])
        : [],
    ),
  );
}

function ticketAggs(s: MockTicketState, key: string | null): Record<string, DriverAggCounter> {
  const out: Record<string, DriverAggCounter> = {};
  for (const [k, f, v] of entries(s)) if (key === null || k === key) out[f] = bump(out[f], v);
  return out;
}

/** The board as tickets.boards() gives it, lifetime counters included. */
export const mockBoardOut = (s: MockTicketState): DriverBoard => ({
  ...structuredCloneSafe(MOCK_BOARD),
  aggs: ticketAggs(s, null),
});

/** tickets.aggregates: like the real one — field by id or label, 30 days / 12 weeks / 12 months by default. */
export function mockAggregates(
  s: MockTicketState,
  board: unknown,
  q: AggregateQuery | undefined,
  now = Date.now(),
): DriverAggregates {
  mockBoard(board);
  const query = q ?? {};
  const fields = MOCK_BOARD.aggFields;
  const ref = query.field;
  const field = ref
    ? (fields.find((f) => f.id === ref || same(f.label, String(ref))) ??
      fail('invalid-argument', `No aggregate field "${String(ref)}" on DEMO (have: Cost, Time)`))
    : fields[0]!;
  const p = field.period;
  for (const v of [query.from, query.to])
    if (v !== undefined && !KEY_RE[p].test(String(v)))
      fail('invalid-argument', `"${String(v)}" is not a ${p} key`);
  const d = new Date(now);
  const from =
    query.from ??
    (p === 'daily'
      ? periodKey(p, now - 29 * DAY)
      : p === 'weekly'
        ? periodKey(p, now - 77 * DAY)
        : periodKey(p, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 11, 1)));
  const to = query.to ?? null;
  const by = new Map<string, DriverAggBucket>();
  for (const [key, f, v, at] of entries(s)) {
    const k = periodKey(p, at);
    if (f !== field.id || k < from || (to !== null && k > to)) continue;
    const b = by.get(k) ?? { key: k, total: 0, count: 0, tickets: {} };
    Object.assign(b, bump(b, v));
    b.tickets[key] = bump(b.tickets[key], v);
    by.set(k, b);
  }
  const buckets = [...by.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  return {
    field: { ...field },
    from,
    to,
    total: round(buckets.reduce((n, b) => n + b.total, 0)),
    count: buckets.reduce((n, b) => n + b.count, 0),
    lifetime: ticketAggs(s, null)[field.id] ?? { total: 0, count: 0 },
    buckets,
  };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
function find<T extends { id: string; name: string }>(list: T[], ref: unknown, what: string): T {
  const r = String(ref);
  return (
    list.find((x) => x.id === r || same(x.name, r)) ??
    fail('invalid-argument', `Unknown ${what} "${r}" (have: ${list.map((x) => x.name).join(', ')})`)
  );
}
function person(ref: unknown): DriverPerson {
  const r = String(ref);
  if (r === 'me') return ME;
  return (
    MOCK_BOARD.members.find((m) => m.id === r || (m.email && same(m.email, r))) ??
    fail('invalid-argument', `"${r}" is not on this board`)
  );
}
function when(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v === 'number' && v >= 0) return v;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? fail('invalid-argument', `Not a date: ${String(v)}`) : t;
}

export function mockBoard(ref: unknown): DriverBoard {
  const r = String(ref ?? '');
  if (r.toUpperCase() === MOCK_BOARD.key || r === MOCK_BOARD.id) return MOCK_BOARD;
  return fail('permission-denied', `This artifact has no access to board ${r} (the mock has DEMO)`);
}

export function listTickets(s: MockTicketState, q: TicketQuery | undefined): DriverTicket[] {
  const query = q ?? {};
  const state = query.state ?? 'active';
  const stage = query.stage ? find(MOCK_BOARD.stages, query.stage, 'stage').id : null;
  const who =
    query.assignee === undefined
      ? undefined
      : query.assignee === null
        ? null
        : person(query.assignee).id;
  const limit = Math.min(500, Math.max(1, Number(query.limit ?? 200) || 200));
  const order = query.orderBy ?? 'rank';
  return s.tickets
    .filter(
      (t) =>
        t.state === state &&
        (stage === null || t.stage.id === stage) &&
        (who === undefined ||
          (who === null ? !t.assignees.length : t.assignees.some((a) => a.id === who))),
    )
    .sort((a, b) =>
      order === 'updated'
        ? b.updatedAt - a.updatedAt
        : order === 'created'
          ? b.createdAt - a.createdAt
          : order === 'due'
            ? (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity)
            : a.id < b.id
              ? -1
              : 1,
    )
    .slice(0, limit)
    .map((t) => structuredCloneSafe(t));
}

function apply(t: DriverTicket, p: Partial<TicketInput>): void {
  if (p.title !== undefined) {
    if (typeof p.title !== 'string' || !p.title.trim())
      fail('invalid-argument', 'title must be a non-empty string');
    t.title = p.title.trim();
  }
  if (p.description !== undefined) t.description = String(p.description ?? '');
  if (p.stage !== undefined) t.stage = find(MOCK_BOARD.stages, p.stage, 'stage');
  if (p.priority !== undefined)
    t.priority = p.priority === null ? null : find(MOCK_BOARD.priorities, p.priority, 'priority');
  if (p.tags !== undefined) t.tags = p.tags.map((x) => find(MOCK_BOARD.tags, x, 'tag').name);
  if (p.assignees !== undefined) t.assignees = p.assignees.map(person);
  if (p.dueAt !== undefined) t.dueAt = when(p.dueAt);
  if (p.startAt !== undefined) t.startAt = when(p.startAt);
  if (p.fields !== undefined) t.fields = { ...t.fields, ...p.fields };
  t.updatedAt = Date.now();
}

export function createTicket(s: MockTicketState, input: TicketInput): { id: string; key: string } {
  if (!input || typeof input !== 'object')
    return fail('invalid-argument', 'ticket must be an object');
  const n = ++s.seq;
  const t: DriverTicket = {
    ...seedTickets().tickets[3]!,
    id: `mock-t${n}`,
    key: `DEMO-${n}`,
    url: `https://example.invalid/t/DEMO-${n}`,
    title: '',
    fields: {},
    messages: 0,
    aggs: {},
    createdAt: Date.now(),
  };
  apply(t, { ...input, title: input.title ?? '' });
  s.tickets.push(t);
  return { id: t.id, key: t.key };
}

export function ticketByKey(s: MockTicketState, key: unknown): DriverTicket | null {
  const k = String(key ?? '')
    .trim()
    .replace(/^#/, '')
    .toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(k))
    fail('invalid-argument', `"${String(key)}" is not a ticket key like DEMO-1`);
  mockBoard(k.split('-')[0]);
  return s.tickets.find((t) => t.key === k) ?? null;
}

export function updateTicket(s: MockTicketState, key: unknown, patch: Partial<TicketInput>): void {
  const t = ticketByKey(s, key) ?? fail('not-found', `No ticket ${String(key)}`);
  if (!patch || typeof patch !== 'object') fail('invalid-argument', 'patch must be an object');
  apply(t, patch);
}

export function commentTicket(s: MockTicketState, key: unknown, markdown: unknown): void {
  const t = ticketByKey(s, key) ?? fail('not-found', `No ticket ${String(key)}`);
  if (typeof markdown !== 'string' || !markdown.trim())
    fail('invalid-argument', 'comment needs Markdown text');
  (s.threads[t.key] ??= []).push(
    msg(Date.now(), ME, markdown as string, {
      id: `mock-c${Date.now().toString(36)}${t.messages}`,
    }),
  );
  t.messages += 1;
  t.updatedAt = Date.now();
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

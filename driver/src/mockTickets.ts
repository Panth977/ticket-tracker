/**
 * The mock's §K board: one 'DEMO' board granted 'write', a handful of tickets,
 * kept with the rest of the mock state so a reload keeps them. Lightweight on
 * purpose — the real converters (@tm/shared/artifacts/tickets) pull in the
 * Markdown editor's parser, which has no place in the driver bundle — so it
 * resolves names the simple way and keeps descriptions as the Markdown given.
 */
import type {
  DriverBoard,
  DriverPerson,
  DriverTicket,
  TicketInput,
  TicketQuery,
} from '@tm/shared/artifacts/driver';
import { fail } from './transport.js';

export interface MockTicketState {
  tickets: DriverTicket[];
  seq: number;
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
    createdAt: now - (10 - n) * DAY,
    updatedAt: now - n * 3_600_000,
  });
  return {
    seq: 5,
    tickets: [
      t(1, 'Sketch the dashboard', 2, [ME], -3, null),
      t(2, 'Wire the numbers', 1, [ME, BOT], 1, 0),
      t(3, 'Fix the chart colours', 0, [ALEX], 4, 1),
      t(4, 'Ask for feedback', 0, [], null, null),
      t(5, 'Ship it', 0, [ME], 7, 0),
    ],
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
  t.messages += 1;
  t.updatedAt = Date.now();
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

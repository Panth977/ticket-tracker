import { describe, expect, it } from 'vitest';
import {
  ALL_KEY,
  NONE_KEY,
  applyView,
  applyViewFlat,
  matchesFilter,
  sortTickets,
  type ViewBoard,
  type ViewCtx,
  type ViewTicket,
} from './view.js';
import type { FilterNode } from '../types/index.js';

// Tue 2026-09-22 14:30 in Kolkata.
const NOW = Date.UTC(2026, 8, 22, 9, 0);
const IST = 'Asia/Kolkata';
const H = 3_600_000;
const D = 24 * H;
const ctx: ViewCtx = { me: 'me', now: NOW, tz: IST };

const board: ViewBoard = {
  stages: [
    { id: 'done', name: 'Done', color: 'green', category: 'done', position: 3 },
    { id: 'todo', name: 'To do', color: 'grey', category: 'todo', position: 1 },
    { id: 'doing', name: 'Doing', color: 'blue', category: 'active', position: 2 },
  ],
  priorities: [
    { id: 'hi', name: 'High', position: 1 },
    { id: 'lo', name: 'Low', position: 2 },
  ],
  tags: [
    { id: 'bug', name: 'bug', position: 1 },
    { id: 'ux', name: 'ux', position: 2 },
  ],
  fields: [
    {
      id: 'f_client',
      name: 'Client',
      type: 'select',
      position: 1,
      options: [
        { id: 'acme', name: 'Acme', position: 1 },
        { id: 'zen', name: 'Zen', position: 2 },
      ],
    },
    { id: 'f_value0', name: 'Value', type: 'currency', position: 2 },
    { id: 'f_signed', name: 'Signed', type: 'checkbox', position: 3 },
    { id: 'f_golive', name: 'Go live', type: 'date', position: 4 },
    { id: 'f_notes0', name: 'Notes', type: 'text', position: 5 },
    { id: 'f_owners', name: 'Owners', type: 'people', position: 6 },
  ],
};

let n = 0;
function tk(over: Partial<ViewTicket> = {}): ViewTicket {
  n++;
  return {
    id: `t${n}`,
    key: `ENG-${n}` as ViewTicket['key'],
    number: n,
    title: `Ticket ${n}`,
    stageId: 'todo',
    stageCategory: 'todo',
    priorityId: null,
    tagIds: [],
    state: 'active',
    rank: `a${n}`,
    assigneeUids: [],
    startAt: null,
    dueAt: null,
    dueAllDay: false,
    estimate: null,
    fields: {},
    links: [],
    createdBy: 'me',
    createdAt: NOW - 10 * D,
    updatedAt: NOW - D,
    ...over,
  };
}
const ids = (ts: ViewTicket[]) => ts.map((t) => t.id);
const match = (t: ViewTicket, f: FilterNode) => matchesFilter(t, f, board, ctx);

describe('includeStates', () => {
  it('defaults to active only', () => {
    const a = tk();
    const b = tk({ state: 'archived' });
    expect(ids(applyViewFlat([a, b], {}, board, ctx))).toEqual([a.id]);
    expect(ids(applyViewFlat([a, b], { includeStates: ['archived'] }, board, ctx))).toEqual([b.id]);
  });
});

describe('filter — scalar & set fields', () => {
  const t = tk({
    stageId: 'doing',
    priorityId: 'hi',
    tagIds: ['bug', 'ux'],
    assigneeUids: ['me', 'ann'],
    createdBy: 'ann',
  });
  it.each<[FilterNode, boolean]>([
    [{ field: 'stage', cmp: 'is', value: 'doing' }, true],
    [{ field: 'stage', cmp: 'isNot', value: 'doing' }, false],
    [{ field: 'stage', cmp: 'in', value: ['todo', 'doing'] }, true],
    [{ field: 'stage', cmp: 'notIn', value: ['todo', 'doing'] }, false],
    [{ field: 'priority', cmp: 'is', value: 'lo' }, false],
    [{ field: 'priority', cmp: 'notEmpty' }, true],
    [{ field: 'priority', cmp: 'empty' }, false],
    [{ field: 'assignee', cmp: 'is', value: 'me' }, true], // token
    [{ field: 'assignee', cmp: 'contains', value: 'ann' }, true],
    [{ field: 'assignee', cmp: 'isNot', value: 'me' }, false],
    [{ field: 'assignee', cmp: 'in', value: ['zed', 'me'] }, true],
    [{ field: 'assignee', cmp: 'notIn', value: ['zed'] }, true],
    [{ field: 'tag', cmp: 'is', value: ['bug', 'ux'] }, true], // all of
    [{ field: 'tag', cmp: 'in', value: ['ux', 'nope'] }, true], // any of
    [{ field: 'tag', cmp: 'empty' }, false],
    [{ field: 'createdBy', cmp: 'is', value: 'me' }, false],
    [{ field: 'state', cmp: 'is', value: 'active' }, true],
    [{ field: 'fields.f_zzzzzz', cmp: 'notEmpty' }, false], // unknown field matches nothing
  ])('%j → %s', (f, want) => expect(match(t, f)).toBe(want));
  it('unassigned: assignee empty', () => {
    expect(match(tk(), { field: 'assignee', cmp: 'empty' })).toBe(true);
  });
});

describe('filter — text & linked', () => {
  const t = tk({
    title: 'Fix LOGIN redirect',
    description: { doc: { type: 'doc', content: [] }, text: 'safari only', mentions: [], refs: [] },
  });
  it('text contains searches key, title, description', () => {
    expect(match(t, { field: 'text', cmp: 'contains', value: 'login' })).toBe(true);
    expect(match(t, { field: 'text', cmp: 'contains', value: 'SAFARI' })).toBe(true);
    expect(match(t, { field: 'text', cmp: 'contains', value: t.key.toLowerCase() })).toBe(true);
    expect(match(t, { field: 'text', cmp: 'isNot', value: 'login' })).toBe(false);
    expect(match(t, { field: 'text', cmp: 'contains', value: 'chrome' })).toBe(false);
  });
  it('linked covers links and references both ways', () => {
    const a = tk({ links: [{ type: 'blocks', ticketId: 'x' }] });
    const b = tk({ referencedBy: ['y'] });
    expect(match(a, { field: 'linked', cmp: 'notEmpty' })).toBe(true);
    expect(match(a, { field: 'linked', cmp: 'is', value: 'x' })).toBe(true);
    expect(match(b, { field: 'linked', cmp: 'contains', value: 'y' })).toBe(true);
    expect(match(tk(), { field: 'linked', cmp: 'empty' })).toBe(true);
  });
});

describe('filter — dates & tokens', () => {
  const todayStart = Date.UTC(2026, 8, 21, 18, 30); // 00:00 IST Tue
  const dueToday = tk({ dueAt: todayStart + 20 * H });
  const dueTomorrow = tk({ dueAt: todayStart + D + H });
  const dueNextWeek = tk({ dueAt: todayStart + 7 * D });
  const pastDue = tk({ dueAt: NOW - H });
  const pastDueDone = tk({ dueAt: NOW - H, stageId: 'done', stageCategory: 'done' });
  const allDayToday = tk({ dueAt: todayStart, dueAllDay: true });
  const none = tk();

  it('today', () => {
    const f: FilterNode = { field: 'due', cmp: 'is', value: 'today' };
    expect([dueToday, dueTomorrow, pastDue, allDayToday, none].map((t) => match(t, f))).toEqual([
      true,
      false,
      true,
      true,
      false,
    ]);
  });
  it('thisWeek (Mon–Sun)', () => {
    const f: FilterNode = { field: 'due', cmp: 'is', value: 'thisWeek' };
    expect([dueToday, dueTomorrow, dueNextWeek].map((t) => match(t, f))).toEqual([
      true,
      true,
      false,
    ]);
  });
  it('overdue: past, not done, all-day lasts the day', () => {
    const f: FilterNode = { field: 'due', cmp: 'is', value: 'overdue' };
    expect([pastDue, pastDueDone, dueToday, allDayToday, none].map((t) => match(t, f))).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });
  it('before / after / between / lt / gt', () => {
    expect(match(pastDue, { field: 'due', cmp: 'before', value: NOW })).toBe(true);
    expect(match(dueTomorrow, { field: 'due', cmp: 'after', value: 'today' })).toBe(true);
    expect(match(dueToday, { field: 'due', cmp: 'after', value: 'today' })).toBe(false);
    expect(match(dueToday, { field: 'due', cmp: 'before', value: 'today' })).toBe(false);
    expect(match(dueNextWeek, { field: 'due', cmp: 'between', value: ['today', 'thisWeek'] })).toBe(
      false,
    );
    expect(match(dueTomorrow, { field: 'due', cmp: 'between', value: ['today', 'thisWeek'] })).toBe(
      true,
    );
    expect(match(dueTomorrow, { field: 'due', cmp: 'between', value: [NOW, NOW + 2 * D] })).toBe(
      true,
    );
    expect(match(dueTomorrow, { field: 'due', cmp: 'lt', value: NOW })).toBe(false);
    expect(match(dueTomorrow, { field: 'due', cmp: 'gt', value: NOW })).toBe(true);
    expect(match(none, { field: 'due', cmp: 'empty' })).toBe(true);
    expect(match(none, { field: 'due', cmp: 'isNot', value: 'today' })).toBe(true);
    expect(match(dueToday, { field: 'due', cmp: 'is', value: '2026-09-22' })).toBe(true);
    expect(match(dueToday, { field: 'due', cmp: 'in', value: ['overdue', 'today'] })).toBe(true);
  });
  it('custom date field', () => {
    const t = tk({ fields: { f_golive: todayStart + H } });
    expect(match(t, { field: 'fields.f_golive', cmp: 'is', value: 'today' })).toBe(true);
    expect(match(t, { field: 'fields.f_golive', cmp: 'is', value: 'overdue' })).toBe(false); // overdue is about due only
  });
  it('another zone sees another today', () => {
    const f: FilterNode = { field: 'due', cmp: 'is', value: 'today' };
    // 01:00 IST Wed = 15:30 Tue in New York
    const t = tk({ dueAt: todayStart + D + H });
    expect(matchesFilter(t, f, board, ctx)).toBe(false);
    expect(matchesFilter(t, f, board, { ...ctx, tz: 'America/New_York' })).toBe(true);
  });
});

describe('filter — custom fields', () => {
  const t = tk({
    fields: {
      f_client: 'acme',
      f_value0: 1200,
      f_signed: true,
      f_notes0: 'Needs SSO',
      f_owners: ['me'],
    },
  });
  it.each<[FilterNode, boolean]>([
    [{ field: 'fields.f_client', cmp: 'is', value: 'acme' }, true],
    [{ field: 'fields.f_client', cmp: 'in', value: ['zen'] }, false],
    [{ field: 'fields.f_value0', cmp: 'gt', value: 1000 }, true],
    [{ field: 'fields.f_value0', cmp: 'lt', value: 1000 }, false],
    [{ field: 'fields.f_value0', cmp: 'between', value: [1000, 1200] }, true],
    [{ field: 'fields.f_value0', cmp: 'is', value: 1200 }, true],
    [{ field: 'fields.f_signed', cmp: 'is', value: true }, true],
    [{ field: 'fields.f_notes0', cmp: 'contains', value: 'sso' }, true],
    [{ field: 'fields.f_owners', cmp: 'is', value: 'me' }, true],
  ])('%j → %s', (f, want) => expect(match(t, f)).toBe(want));
  it('unchecked checkbox is empty', () => {
    expect(match(tk(), { field: 'fields.f_signed', cmp: 'empty' })).toBe(true);
  });
});

describe('filter — trees', () => {
  const mine = tk({ assigneeUids: ['me'], priorityId: 'hi' });
  const theirs = tk({ assigneeUids: ['ann'], priorityId: 'hi' });
  const low = tk({ assigneeUids: ['me'], priorityId: 'lo' });
  it('and / or nest', () => {
    const f: FilterNode = {
      op: 'or',
      children: [
        {
          op: 'and',
          children: [
            { field: 'assignee', cmp: 'is', value: 'me' },
            { field: 'priority', cmp: 'is', value: 'hi' },
          ],
        },
        { field: 'assignee', cmp: 'is', value: 'ann' },
      ],
    };
    expect([mine, theirs, low].map((t) => match(t, f))).toEqual([true, true, false]);
  });
  it('an empty group matches everything', () => {
    expect(match(low, { op: 'and', children: [] })).toBe(true);
    expect(match(low, { op: 'or', children: [] })).toBe(true);
  });
});

describe('sort', () => {
  it('multi-key, nulls last in both directions, ties by rank', () => {
    const a = tk({ priorityId: 'lo', rank: 'a3', dueAt: 5 });
    const b = tk({ priorityId: 'hi', rank: 'a2', dueAt: null });
    const c = tk({ priorityId: 'hi', rank: 'a1', dueAt: 9 });
    const d = tk({ priorityId: null, rank: 'a0' });
    expect(ids(sortTickets([a, b, c, d], [{ field: 'priority', dir: 'asc' }], board))).toEqual([
      c.id,
      b.id,
      a.id,
      d.id,
    ]);
    expect(ids(sortTickets([a, b, c, d], [{ field: 'priority', dir: 'desc' }], board))).toEqual([
      a.id,
      c.id,
      b.id,
      d.id,
    ]);
    expect(
      ids(
        sortTickets(
          [a, b, c, d],
          [
            { field: 'priority', dir: 'asc' },
            { field: 'due', dir: 'desc' },
          ],
          board,
        ),
      ),
    ).toEqual([c.id, b.id, a.id, d.id]);
    expect(ids(sortTickets([a, b, c, d], [{ field: 'due', dir: 'desc' }], board))).toEqual([
      c.id,
      a.id,
      d.id,
      b.id,
    ]);
  });
  it('default order is rank', () => {
    const a = tk({ rank: 'b' });
    const b = tk({ rank: 'a' });
    expect(ids(sortTickets([a, b], [], board))).toEqual([b.id, a.id]);
  });
  it('stage sorts by board position; title case-insensitively', () => {
    const a = tk({ stageId: 'done', title: 'b' });
    const b = tk({ stageId: 'todo', title: 'C' });
    const c = tk({ stageId: 'doing', title: 'a' });
    expect(ids(sortTickets([a, b, c], [{ field: 'stage', dir: 'asc' }], board))).toEqual([
      b.id,
      c.id,
      a.id,
    ]);
    expect(ids(sortTickets([a, b, c], [{ field: 'title', dir: 'asc' }], board))).toEqual([
      c.id,
      a.id,
      b.id,
    ]);
  });
  it('custom numeric field', () => {
    const a = tk({ fields: { f_value0: 10 } });
    const b = tk({ fields: { f_value0: 2 } });
    expect(ids(sortTickets([a, b], [{ field: 'fields.f_value0', dir: 'asc' }], board))).toEqual([
      b.id,
      a.id,
    ]);
  });
});

describe('groupBy', () => {
  it('ungrouped → one ALL group', () => {
    const g = applyView([tk()], {}, board, ctx);
    expect(g).toHaveLength(1);
    expect(g[0]!.key).toBe(ALL_KEY);
  });
  it('stage: every column in board order, empty ones too, no NONE', () => {
    const t = tk({ stageId: 'doing' });
    const g = applyView([t], { groupBy: 'stage' }, board, ctx);
    expect(g.map((x) => x.key)).toEqual(['todo', 'doing', 'done']);
    expect(g.map((x) => x.label)).toEqual(['To do', 'Doing', 'Done']);
    expect(ids(g[1]!.tickets)).toEqual([t.id]);
  });
  it('stage: an orphaned ticket gets a NONE column', () => {
    const g = applyView([tk({ stageId: 'gone' })], { groupBy: 'stage' }, board, ctx);
    expect(g.at(-1)!.key).toBe(NONE_KEY);
  });
  it('priority keeps an empty NONE bucket as a drop target', () => {
    const g = applyView([tk({ priorityId: 'hi' })], { groupBy: 'priority' }, board, ctx);
    expect(g.map((x) => x.key)).toEqual(['hi', 'lo', NONE_KEY]);
  });
  it('assignee: ticket in each assignee group, me first, unassigned last', () => {
    const a = tk({ assigneeUids: ['zed', 'me'] });
    const b = tk({ assigneeUids: ['ann'] });
    const c = tk();
    const g = applyView([a, b, c], { groupBy: 'assignee' }, board, ctx);
    expect(g.map((x) => x.key)).toEqual(['me', 'ann', 'zed', NONE_KEY]);
    expect(ids(g[0]!.tickets)).toEqual([a.id]);
    expect(ids(g[2]!.tickets)).toEqual([a.id]);
    expect(ids(g[3]!.tickets)).toEqual([c.id]);
  });
  it('assignee with nobody unassigned drops NONE', () => {
    const g = applyView([tk({ assigneeUids: ['me'] })], { groupBy: 'assignee' }, board, ctx);
    expect(g.map((x) => x.key)).toEqual(['me']);
  });
  it('tag: multi-valued', () => {
    const a = tk({ tagIds: ['ux', 'bug'] });
    const g = applyView([a, tk()], { groupBy: 'tag' }, board, ctx);
    expect(g.map((x) => [x.key, x.tickets.length])).toEqual([
      ['bug', 1],
      ['ux', 1],
      [NONE_KEY, 1],
    ]);
  });
  it('fields.* select / checkbox / number', () => {
    const a = tk({ fields: { f_client: 'zen', f_signed: true, f_value0: 5 } });
    const b = tk({ fields: { f_value0: 20 } });
    expect(
      applyView([a, b], { groupBy: 'fields.f_client' }, board, ctx).map((x) => [
        x.key,
        x.tickets.length,
      ]),
    ).toEqual([
      ['acme', 0],
      ['zen', 1],
      [NONE_KEY, 1],
    ]);
    expect(
      applyView([a, b], { groupBy: 'fields.f_signed' }, board, ctx).map((x) => [
        x.key,
        x.tickets.length,
      ]),
    ).toEqual([
      ['true', 1],
      ['false', 1],
    ]);
    expect(applyView([a, b], { groupBy: 'fields.f_value0' }, board, ctx).map((x) => x.key)).toEqual(
      ['5', '20'],
    );
  });
  it('groups keep the sort order inside', () => {
    const a = tk({ stageId: 'todo', rank: 'b' });
    const b = tk({ stageId: 'todo', rank: 'a' });
    const g = applyView([a, b], { groupBy: 'stage' }, board, ctx);
    expect(ids(g[0]!.tickets)).toEqual([b.id, a.id]);
  });
});

describe('subGroupBy (swimlanes)', () => {
  it('every column has the same lanes in the same order', () => {
    const a = tk({ stageId: 'todo', assigneeUids: ['ann'] });
    const b = tk({ stageId: 'doing', assigneeUids: ['me'] });
    const c = tk({ stageId: 'doing' });
    const g = applyView([a, b, c], { groupBy: 'stage', subGroupBy: 'assignee' }, board, ctx);
    for (const col of g) expect(col.subGroups!.map((l) => l.key)).toEqual(['me', 'ann', NONE_KEY]);
    const doing = g.find((x) => x.key === 'doing')!;
    expect(doing.subGroups!.map((l) => ids(l.tickets))).toEqual([[b.id], [], [c.id]]);
  });
  it('filter + sort + group + lanes together', () => {
    const a = tk({ stageId: 'todo', priorityId: 'hi', assigneeUids: ['me'], dueAt: NOW + H });
    const b = tk({ stageId: 'todo', priorityId: 'lo', assigneeUids: ['me'], dueAt: NOW + 2 * H });
    const c = tk({ stageId: 'todo', priorityId: 'hi', assigneeUids: ['ann'] });
    const g = applyView(
      [a, b, c],
      {
        filter: { field: 'assignee', cmp: 'is', value: 'me' },
        sort: [{ field: 'due', dir: 'desc' }],
        groupBy: 'stage',
        subGroupBy: 'priority',
        includeStates: ['active'],
      },
      board,
      ctx,
    );
    const todo = g[0]!;
    expect(ids(todo.tickets)).toEqual([b.id, a.id]);
    expect(todo.subGroups!.map((l) => [l.key, ids(l.tickets)])).toEqual([
      ['hi', [a.id]],
      ['lo', [b.id]],
      [NONE_KEY, []],
    ]);
  });
});

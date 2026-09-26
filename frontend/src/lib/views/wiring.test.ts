/**
 * View wiring: what the board screen does between the saved View, the draft
 * the View bar edits, the shared view engine (applyView) and the one
 * ticketUpdate a drag writes. The engine itself is tested in @tm/shared;
 * these check the glue the board route relies on.
 */
import { describe, expect, it } from 'vitest';
import type { TicketWithId, ViewInput } from '@tm/shared';
import { applyView, NONE_KEY } from '@tm/shared/logic/view';
import { fixtures, T0, UID_ASHA, UID_PRIYA } from '@tm/shared/schema/fixtures';
import {
  DEFAULT_COLUMNS,
  fallbackView,
  newViewInput,
  sameView,
  toInput,
  visibleColumns,
  withType,
} from './draft';
import { andWith, countConditions, normalize } from './filter';
import { dropPosition, mergePatches, movePatch, overlayFor } from './move';

const board = fixtures.boards;
const ctx = { me: UID_ASHA, now: T0, tz: 'UTC', weekStartsOn: 1 };
const ticket = (id: string, over: Partial<TicketWithId> = {}): TicketWithId =>
  ({ ...fixtures.tickets, id, boardId: 'board_eng', key: `ENG-${id}`, ...over }) as TicketWithId;

/** Apply a patch the way the server would (fields merged per key). */
function applyPatch(t: TicketWithId, p: ReturnType<typeof movePatch>): TicketWithId {
  if (!p) return t;
  const { fields, ...rest } = p;
  return { ...t, ...rest, fields: { ...t.fields, ...fields } } as TicketWithId;
}

describe('drafts', () => {
  it('newViewInput gives each type its defaults', () => {
    expect(newViewInput('kanban')).toMatchObject({
      groupBy: 'stage',
      dateField: null,
      columns: [],
    });
    expect(newViewInput('table').columns).toEqual(DEFAULT_COLUMNS);
    expect(newViewInput('calendar')).toMatchObject({ groupBy: null, dateField: 'due' });
    expect(newViewInput('timeline')).toMatchObject({ dateField: 'start', endDateField: 'due' });
  });

  it('a stored view round-trips to an equal draft; name / scope / position never make it dirty', () => {
    const saved = toInput(fixtures.views);
    expect(sameView(saved, saved)).toBe(true);
    expect(sameView({ ...saved, name: 'Other', scope: 'shared', position: 9 }, saved)).toBe(true);
    expect(sameView({ ...saved, groupBy: 'priority' }, saved)).toBe(false);
  });

  it('key order and includeStates order do not count as changes', () => {
    const a = newViewInput('kanban', { name: 'A' });
    const b = { ...a, includeStates: ['archived', 'active'] as ViewInput['includeStates'] };
    const c = { ...a, includeStates: ['active', 'archived'] as ViewInput['includeStates'] };
    expect(sameView(b, c)).toBe(true);
    // Same content, keys in reverse order.
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as ViewInput;
    expect(sameView(reordered, a)).toBe(true);
  });

  it('an empty filter group is the same as no filter', () => {
    const a = newViewInput('kanban');
    expect(sameView({ ...a, filter: { op: 'and', children: [] } }, a)).toBe(true);
    expect(normalize({ op: 'and', children: [] })).toBeNull();
  });

  it('switching type keeps filter + sort and adopts the new type’s layout', () => {
    const k = {
      ...newViewInput('kanban'),
      filter: { field: 'stage', cmp: 'is' as const, value: 'st_todo' },
      sort: [{ field: 'due', dir: 'asc' as const }],
    };
    const t = withType(k, 'table');
    expect(t).toMatchObject({ type: 'table', filter: k.filter, sort: k.sort, subGroupBy: null });
    expect(t.columns).toEqual(DEFAULT_COLUMNS);
    const c = withType(t, 'calendar');
    expect(c).toMatchObject({ groupBy: null, dateField: 'due' });
    expect(withType(c, 'timeline').endDateField).toBe('due');
  });

  it('visibleColumns hides hidden ones and falls back to the defaults', () => {
    expect(visibleColumns({ columns: [] })).toEqual(DEFAULT_COLUMNS);
    expect(
      visibleColumns({
        columns: [
          { field: 'key', width: 90 },
          { field: 'due', width: 90, hidden: true },
        ],
      }).map((c) => c.field),
    ).toEqual(['key']);
  });

  it('fallbackView is a shared kanban keyed by the board’s default view', () => {
    expect(fallbackView({ defaultViewId: 'v1' })).toMatchObject({
      id: 'v1',
      type: 'kanban',
      scope: 'shared',
    });
  });
});

describe('search box + filter', () => {
  it('the search box ANDs a text condition onto the view’s filter', () => {
    const f = { field: 'stage', cmp: 'is' as const, value: 'st_todo' };
    const both = andWith(f, { field: 'text', cmp: 'contains', value: 'login' });
    expect(countConditions(both)).toBe(2);
    expect(andWith(null, null)).toBeNull();
    expect(andWith(f, null)).toEqual(f);
  });

  it('applyView over the draft + search narrows the board', () => {
    const ts = [ticket('1'), ticket('2', { title: 'Write docs' })];
    const spec = {
      ...newViewInput('table'),
      filter: andWith(null, { field: 'text', cmp: 'contains', value: 'login' }),
    };
    const [all] = applyView(ts, { ...spec, groupBy: null }, board, ctx);
    expect(all!.tickets.map((t) => t.id)).toEqual(['1']);
  });
});

describe('a drag is one ticketUpdate', () => {
  it('stage column → stage column writes stageId only', () => {
    expect(movePatch('stage', 'st_todo', 'st_rev', ticket('1'), board)).toEqual({
      stageId: 'st_rev',
    });
    expect(movePatch('stage', 'st_todo', 'st_todo', ticket('1'), board)).toBeNull();
    expect(movePatch('stage', 'st_todo', NONE_KEY, ticket('1'), board)).toBeNull();
  });

  it('person columns swap the dragged-from person for the dropped-on one', () => {
    const t = ticket('1', { assigneeUids: [UID_PRIYA, 'uid_raj'] });
    expect(movePatch('assignee', UID_PRIYA, UID_ASHA, t, board)).toEqual({
      assigneeUids: ['uid_raj', UID_ASHA],
    });
    expect(movePatch('assignee', UID_PRIYA, NONE_KEY, t, board)).toEqual({ assigneeUids: [] });
  });

  it('custom select columns write fields.{id}; priority / tag too', () => {
    expect(movePatch('fields.f_client', 'o_acme', NONE_KEY, ticket('1'), board)).toEqual({
      fields: { f_client: null },
    });
    expect(movePatch('priority', 'p_high', NONE_KEY, ticket('1'), board)).toEqual({
      priorityId: null,
    });
    expect(movePatch('tag', 'tg_bug', 'tg_new', ticket('1'), board)).toEqual({
      tagIds: ['tg_new'],
    });
    // A text field can't be a column.
    expect(movePatch('fields.f_soluti', 'a', 'b', ticket('1'), board)).toBeNull();
  });

  it('column + swimlane moves merge into one patch', () => {
    const p = mergePatches({ stageId: 'st_rev' }, { fields: { f_client: null } });
    expect(p).toEqual({ stageId: 'st_rev', fields: { f_client: null } });
    expect(mergePatches(null, null)).toBeNull();
  });

  it('after the patch the engine files the ticket under the target column', () => {
    const t = ticket('1');
    const moved = applyPatch(t, movePatch('stage', 'st_todo', 'st_rev', t, board));
    const groups = applyView([moved], { ...newViewInput('kanban') }, board, ctx);
    expect(groups.find((g) => g.key === 'st_rev')!.tickets.map((x) => x.id)).toEqual(['1']);
    expect(groups.find((g) => g.key === 'st_todo')!.tickets).toEqual([]);
  });

  it('drop position → neighbours for the server and a local rank between them', () => {
    const col = [
      { id: 'a', rank: 'a0' },
      { id: 'x', rank: 'zz' }, // just dropped here
      { id: 'b', rank: 'a2' },
    ];
    const pos = dropPosition(col, 'x')!;
    expect(pos.after).toBe('a');
    expect(pos.before).toBe('b');
    expect(pos.rank > 'a0' && pos.rank < 'a2').toBe(true);
    expect(dropPosition(col, 'missing')).toBeNull();
  });

  it('the optimistic overlay uses dotted keys so other custom fields survive', () => {
    expect(
      overlayFor({ stageId: 's', fields: { f_client: 'o_x' } }, { stageCategory: 'active' }),
    ).toEqual({
      stageCategory: 'active',
      stageId: 's',
      'fields.f_client': 'o_x',
    });
  });
});

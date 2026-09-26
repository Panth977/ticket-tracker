import { describe, expect, it } from 'vitest';
import {
  isOpenWork,
  parseScope,
  parseTile,
  scopeQuery,
  sortWork,
  tileCounts,
  tilesOf,
  visibleWork,
  type MyTicket,
} from './myWork';

// Wednesday 2026-09-23 12:00 UTC
const NOW = Date.UTC(2026, 8, 23, 12);
const H = 3_600_000;
const D = 24 * H;
let n = 0;
function t(p: Partial<MyTicket> = {}): MyTicket {
  n++;
  return {
    id: `t${n}`,
    boardId: 'b1',
    key: `ENG-${n}` as MyTicket['key'],
    number: n,
    title: `Ticket ${n}`,
    description: null,
    stageId: 's1',
    stageCategory: 'todo',
    priorityId: null,
    tagIds: [],
    state: 'active',
    rank: 'a',
    assigneeUids: ['me'],
    watcherUids: ['me'],
    reporter: { uid: 'me', name: 'Me' },
    startAt: null,
    dueAt: null,
    dueAllDay: false,
    commitments: {},
    estimate: null,
    fields: {},
    refs: [],
    referencedBy: [],
    links: [],
    counts: { messages: 0, files: 0, pinned: 0 },
    lastMessageAt: null,
    lastActivityAt: NOW - n,
    dueNotified: {},
    createdBy: 'me',
    createdVia: 'app',
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...p,
  } as MyTicket;
}

describe('my work', () => {
  it('parses URL state', () => {
    expect(parseScope('watching')).toBe('watching');
    expect(parseScope('x')).toBe('assigned');
    expect(parseTile('today')).toBe('today');
    expect(parseTile(null)).toBeNull();
  });

  it('builds rule-provable collection-group queries', () => {
    expect(scopeQuery('assigned', 'me')).toMatchObject({
      group: true,
      where: [
        ['assigneeUids', 'array-contains', 'me'],
        ['stageCategory', 'in', ['backlog', 'todo', 'active']],
      ],
    });
    expect(scopeQuery('created', 'me').where).toEqual([['createdBy', '==', 'me']]);
    expect(scopeQuery('watching', 'me').where).toEqual([['watcherUids', 'array-contains', 'me']]);
  });

  it('open work excludes done stages and archived tickets', () => {
    expect(isOpenWork(t())).toBe(true);
    expect(isOpenWork(t({ stageCategory: 'done' }))).toBe(false);
    expect(isOpenWork(t({ state: 'archived' }))).toBe(false);
  });

  it('assigns tiles', () => {
    expect([...tilesOf(t({ dueAt: NOW - H }), 'me', NOW, 'UTC')]).toEqual(['overdue']);
    expect([...tilesOf(t({ dueAt: NOW + H }), 'me', NOW, 'UTC')].sort()).toEqual(['today', 'week']);
    expect([...tilesOf(t({ dueAt: NOW + 2 * D }), 'me', NOW, 'UTC')]).toEqual(['week']);
    expect([...tilesOf(t({ dueAt: NOW + 9 * D }), 'me', NOW, 'UTC')]).toEqual([]);
    // All-day due today is not overdue until the day ends.
    expect(
      [...tilesOf(t({ dueAt: Date.UTC(2026, 8, 23), dueAllDay: true }), 'me', NOW, 'UTC')].sort(),
    ).toEqual(['today', 'week']);
    expect([...tilesOf(t({ commitments: { me: NOW } }), 'me', NOW, 'UTC')]).toEqual(['committed']);
    expect([...tilesOf(t({ commitments: { other: NOW } }), 'me', NOW, 'UTC')]).toEqual([]);
  });

  it('counts and filters by tile, overdue first then by due date', () => {
    const late = t({ dueAt: NOW - D });
    const soon = t({ dueAt: NOW + H });
    const later = t({ dueAt: NOW + 3 * D });
    const undated = t();
    const done = t({ dueAt: NOW - D, stageCategory: 'done' });
    const list = [undated, later, soon, late, done];
    expect(tileCounts(list.filter(isOpenWork), 'me', NOW, 'UTC')).toEqual({
      overdue: 1,
      today: 1,
      week: 2,
      committed: 0,
    });
    expect(visibleWork(list, null, 'me', NOW, 'UTC').map((x) => x.id)).toEqual([
      late.id,
      soon.id,
      later.id,
      undated.id,
    ]);
    expect(visibleWork(list, 'today', 'me', NOW, 'UTC').map((x) => x.id)).toEqual([soon.id]);
    expect(sortWork([undated, late], NOW, 'UTC')[0]).toBe(late);
  });
});

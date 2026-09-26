import { describe, expect, it } from 'vitest';
import { matchOption, matchPeople, parseQuickAdd, resolveQuickAdd } from './quickAdd.js';

// Tue 2026-09-22 14:30 IST
const NOW = Date.UTC(2026, 8, 22, 9, 0);
const IST = 'Asia/Kolkata';
const ctx = { now: NOW, tz: IST };
const localMidnight = (m: number, d: number) => Date.UTC(2026, m - 1, d) - 330 * 60_000;

describe('parseQuickAdd', () => {
  it('the example from the spec', () => {
    const q = parseQuickAdd('Fix login @pri !high due:fri #ENG-40 +bug', ctx);
    expect(q).toMatchObject({
      title: 'Fix login',
      assigneeQuery: ['pri'],
      priorityQuery: 'high',
      due: { at: localMidnight(9, 25), allDay: true },
      dueText: 'fri',
      refs: ['ENG-40'],
      tags: ['bug'],
    });
  });
  it('tokens anywhere, title keeps its order', () => {
    const q = parseQuickAdd('@asha Fix +ux the #eng-1 login  redirect +UX');
    expect(q.title).toBe('Fix the login redirect');
    expect(q.tags).toEqual(['ux']);
    expect(q.refs).toEqual(['ENG-1']);
    expect(q.due).toBeNull();
  });
  it('several assignees; last priority wins', () => {
    const q = parseQuickAdd('x @a @b@x.com !low !high');
    expect(q.assigneeQuery).toEqual(['a', 'b@x.com']);
    expect(q.priorityQuery).toBe('high');
  });
  it('non-tokens stay in the title', () => {
    const q = parseQuickAdd('Email a@b.com about #hashtag, C++ and 100% + @ !', ctx);
    expect(q.title).toBe('Email a@b.com about #hashtag, C++ and 100% + @ !');
    expect(q.tokens).toEqual([]);
  });
  it('an unparseable due stays in the title', () => {
    const q = parseQuickAdd('Ship due:someday', ctx);
    expect(q.title).toBe('Ship due:someday');
    expect(q.due).toBeNull();
  });
  it('without ctx the due text is kept, unresolved', () => {
    const q = parseQuickAdd('Ship due:tomorrow');
    expect(q).toMatchObject({ title: 'Ship', dueText: 'tomorrow', due: null });
  });
  it('timed due', () => {
    expect(parseQuickAdd('x due:tomorrow@09:30', ctx).due).toEqual({
      at: localMidnight(9, 23) + 9.5 * 3_600_000,
      allDay: false,
    });
  });
  it('token offsets for highlighting', () => {
    const s = 'Fix @pri +bug';
    const q = parseQuickAdd(s);
    expect(q.tokens.map((t) => [t.kind, s.slice(t.start, t.end)])).toEqual([
      ['assignee', '@pri'],
      ['tag', '+bug'],
    ]);
  });
});

describe('resolve against the board', () => {
  const people = [
    { uid: 'u_priya', name: 'Priya Shah', email: 'priya@x.com' },
    { uid: 'u_prita', name: 'Prita Nair', email: 'prita@x.com' },
    { uid: 'u_asha', name: 'Asha Rao', email: 'asha@x.com' },
  ];
  const board = {
    priorities: [
      { id: 'p_low', name: 'Low', position: 3 },
      { id: 'p_high', name: 'High', position: 1 },
      { id: 'p_med', name: 'Medium', position: 2 },
    ],
    tags: [{ id: 't_bug', name: 'bug', position: 1 }],
  };

  it('matchPeople: name, any word, email prefix', () => {
    expect(matchPeople('pri', people).map((p) => p.uid)).toEqual(['u_prita', 'u_priya']);
    expect(matchPeople('priy', people).map((p) => p.uid)).toEqual(['u_priya']);
    expect(matchPeople('rao', people).map((p) => p.uid)).toEqual(['u_asha']);
    expect(matchPeople('asha@', people).map((p) => p.uid)).toEqual(['u_asha']);
    expect(matchPeople('', people)).toEqual([]);
  });
  it('matchOption: prefix or position', () => {
    expect(matchOption('hi', board.priorities)?.id).toBe('p_high');
    expect(matchOption('1', board.priorities)?.id).toBe('p_high');
    expect(matchOption('3', board.priorities)?.id).toBe('p_low');
    expect(matchOption('urgent', board.priorities)).toBeNull();
  });
  it('resolveQuickAdd', () => {
    const r = resolveQuickAdd(
      parseQuickAdd('Fix login @priy @pri @asha@x.com !high due:fri #ENG-40 +bug +new', ctx),
      board,
      people,
    );
    expect(r).toEqual({
      title: 'Fix login',
      assigneeUids: ['u_priya', 'u_asha'],
      ambiguousAssignees: [{ query: 'pri', candidates: ['u_prita', 'u_priya'] }],
      priorityId: 'p_high',
      dueAt: localMidnight(9, 25),
      dueAllDay: true,
      tagIds: ['t_bug'],
      newTags: ['new'],
      refs: ['ENG-40'],
    });
  });
});

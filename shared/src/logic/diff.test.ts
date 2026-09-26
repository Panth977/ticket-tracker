import { describe, expect, it } from 'vitest';
import { fixtures } from '../schema/fixtures.js';
import type { Ticket } from '../schema/ticket.js';
import { changedKeys, diff, sameValue, setDelta } from './diff.js';

const base: Ticket = fixtures.tickets;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const edit = (over: Partial<Ticket>): Ticket => ({ ...clone(base), ...over });

describe('diff', () => {
  it('no change → empty', () => {
    expect(diff(base, clone(base))).toEqual({});
  });

  it('ignores derived fields', () => {
    const after = edit({
      rank: 'zzz',
      updatedAt: base.updatedAt + 1,
      lastActivityAt: base.lastActivityAt + 1,
      counts: { messages: 99, files: 9, pinned: 1 },
      watcherUids: ['someone'],
      refs: ['x'],
      referencedBy: ['y'],
      dueNotified: { a: { soon: 1 } },
      stageCategory: 'done',
      completedAt: 5,
      lastMessageAt: 7,
    });
    expect(diff(base, after)).toEqual({});
  });

  it('scalar fields, raw ids', () => {
    const after = edit({
      title: 'New',
      stageId: 'stg_qa',
      priorityId: null,
      estimate: 8,
      dueAt: 123,
      dueAllDay: !base.dueAllDay,
      startAt: 5,
      state: 'archived',
    });
    const d = diff(base, after);
    expect(d.title).toEqual({ from: base.title, to: 'New' });
    expect(d.stage).toEqual({ from: base.stageId, to: 'stg_qa' });
    expect(d.priority).toEqual({ from: base.priorityId, to: null });
    expect(d.estimate).toEqual({ from: base.estimate, to: 8 });
    expect(d.due).toEqual({ from: base.dueAt, to: 123 });
    expect(d.dueAllDay).toEqual({ from: base.dueAllDay, to: !base.dueAllDay });
    expect(d.start).toEqual({ from: base.startAt, to: 5 });
    expect(d.state).toEqual({ from: 'active', to: 'archived' });
  });

  it('sets ignore order', () => {
    const b = edit({
      tagIds: ['a', 'b'],
      assigneeUids: ['u1', 'u2'],
      links: [
        { type: 'blocks', ticketId: 't1' },
        { type: 'relates', ticketId: 't2' },
      ],
    });
    const a = edit({
      tagIds: ['b', 'a'],
      assigneeUids: ['u2', 'u1'],
      links: [
        { ticketId: 't2', type: 'relates' },
        { type: 'blocks', ticketId: 't1' },
      ],
    });
    expect(diff(b, a)).toEqual({});
    const c = edit({ ...a, assigneeUids: ['u1'], links: [{ type: 'blockedBy', ticketId: 't1' }] });
    expect(Object.keys(diff(b, c)).sort()).toEqual(['assignees', 'links']);
  });

  it('description compares the doc, reports the text', () => {
    const after = edit({
      description: {
        doc: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new' }] }],
        },
        text: 'new',
        mentions: [],
        refs: [],
      },
    });
    expect(diff(base, after).description).toEqual({
      from: base.description?.text ?? null,
      to: 'new',
    });
    expect(diff(after, edit({ description: null })).description).toEqual({ from: 'new', to: null });
    expect(diff(edit({ description: null }), edit({ description: null }))).toEqual({});
  });

  it('custom fields per id; absent == null; lists as sets', () => {
    const b = edit({ fields: { f_aaaaaa: 'x', f_bbbbbb: ['1', '2'], f_cccccc: null } });
    const a = edit({ fields: { f_aaaaaa: 'y', f_bbbbbb: ['2', '1'], f_dddddd: 5 } });
    expect(diff(b, a)).toEqual({
      'fields.f_aaaaaa': { from: 'x', to: 'y' },
      'fields.f_dddddd': { from: null, to: 5 },
    });
    const r = edit({ fields: { f_eeeeee: { start: 1, end: 2 } } });
    expect(diff(r, edit({ fields: { f_eeeeee: { end: 2, start: 1 } } }))).toEqual({});
    expect(diff(r, edit({ fields: { f_eeeeee: { start: 1, end: 3 } } }))).toHaveProperty([
      'fields.f_eeeeee',
    ]);
  });

  it('commitments per person', () => {
    const b = edit({ commitments: { u1: 1, u2: 2 } });
    const a = edit({ commitments: { u1: 1, u3: 3 } });
    expect(diff(b, a)).toEqual({
      'commitments.u2': { from: 2, to: null },
      'commitments.u3': { from: null, to: 3 },
    });
  });
});

describe('helpers', () => {
  it('setDelta', () => {
    expect(setDelta(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
    expect(setDelta(null, ['x'])).toEqual({ added: ['x'], removed: [] });
  });
  it('changedKeys', () => {
    expect(
      changedKeys({
        title: { from: 1, to: 2 },
        'fields.f_a': { from: 1, to: 2 },
        'fields.f_b': { from: 1, to: 2 },
      }),
    ).toEqual(['title', 'fields']);
  });
  it('sameValue', () => {
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue([1, 2], [2, 1], true)).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });
});

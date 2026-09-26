import { describe, expect, it } from 'vitest';
import {
  dayKey,
  firstUnread,
  GROUP_GAP_MS,
  groupThread,
  mergeThread,
  type ThreadMsg,
} from './thread';

const T0 = Date.UTC(2026, 8, 22, 9, 0);
const m = (
  id: string,
  authorUid: string | null,
  createdAt: number,
  kind: ThreadMsg['kind'] = 'comment',
): ThreadMsg => ({
  id,
  kind,
  authorUid,
  authorName: authorUid ?? 'System',
  createdAt,
});

describe('groupThread', () => {
  it('groups runs by author within the gap, splits days, keeps system lines alone', () => {
    const msgs = [
      m('a', 'u1', T0),
      m('b', 'u1', T0 + 60_000),
      m('c', 'u1', T0 + 60_000 + GROUP_GAP_MS + 1),
      m('s', null, T0 + 60_000 + GROUP_GAP_MS + 2, 'system'),
      m('d', 'u2', T0 + 86_400_000),
    ];
    const out = groupThread(msgs, 'UTC');
    expect(out.map((s) => s.day)).toEqual(['2026-09-22', '2026-09-23']);
    expect(out[0]!.groups.map((g) => g.messages.map((x) => x.id))).toEqual([
      ['a', 'b'],
      ['c'],
      ['s'],
    ]);
    expect(out[1]!.groups[0]!.messages.map((x) => x.id)).toEqual(['d']);
  });
  it('keeps a turn receipt (§Y1) out of its author’s group', () => {
    const run = {
      n: 1,
      outcome: 'review' as const,
      costUsd: 1,
      sessionUsd: 1,
      durationMs: 1000,
      apiTurns: 2,
      model: null,
      usage: null,
    };
    const msgs = [m('a', 'ag', T0), { ...m('r', 'ag', T0 + 1000), run }, m('b', 'ag', T0 + 2000)];
    expect(groupThread(msgs, 'UTC')[0]!.groups.map((g) => g.messages.map((x) => x.id))).toEqual([
      ['a'],
      ['r'],
      ['b'],
    ]);
  });
  it('uses the viewer time zone for days', () => {
    expect(dayKey(Date.UTC(2026, 0, 1, 23, 30), 'Asia/Kolkata')).toBe('2026-01-02');
  });
});

describe('firstUnread', () => {
  const msgs = [m('a', 'u1', 1), m('b', 'me', 5), m('c', 'u2', 6)];
  it('skips my own messages and needs a read pointer', () => {
    expect(firstUnread(msgs, 2, 'me')).toBe('c');
    expect(firstUnread(msgs, null, 'me')).toBeNull();
    expect(firstUnread(msgs, 10, 'me')).toBeNull();
  });
});

describe('mergeThread', () => {
  it('orders oldest-first and drops bubbles already delivered', () => {
    const page = [m('c', 'u', 3), m('a', 'u', 1)];
    const pending = [m('a', 'u', 1), m('p', 'u', 4)];
    expect(mergeThread(page, pending).map((x) => x.id)).toEqual(['a', 'c', 'p']);
  });
});

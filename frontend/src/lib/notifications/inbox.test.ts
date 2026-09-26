import { describe, expect, it } from 'vitest';
import {
  boardKeyOf,
  collapse,
  groupsForTab,
  inTab,
  parseTab,
  rowHeadline,
  rowHref,
  tabCounts,
  timeAgo,
  type Row,
} from './inbox';

const NOW = 1_800_000_000_000;
let n = 0;
function row(p: Partial<Row> = {}): Row {
  n++;
  return {
    id: `n${n}`,
    event: 'comment',
    boardId: 'b1',
    ticketId: 't1',
    ticketKey: 'ENG-42',
    ticketTitle: 'Fix login redirect',
    inviteId: null,
    actor: 'u2',
    via: 'app',
    summary: 'commented',
    groupKey: 't1:comment',
    count: 1,
    createdAt: NOW - n * 1000,
    readAt: null,
    archivedAt: null,
    snoozedUntil: null,
    ...p,
  };
}

describe('tabs', () => {
  it('parses unknown tabs to unread', () => {
    expect(parseTab('mentions')).toBe('mentions');
    expect(parseTab('nope')).toBe('unread');
    expect(parseTab(null)).toBe('unread');
  });

  it('routes rows to tabs', () => {
    const unread = row();
    const read = row({ readAt: NOW });
    const mention = row({ event: 'mentioned', groupKey: 't1:mentioned', readAt: NOW });
    const snoozed = row({ snoozedUntil: NOW + 1000 });
    const woke = row({ snoozedUntil: NOW - 1000 });
    const archived = row({ archivedAt: NOW });
    expect(inTab(unread, 'unread', NOW)).toBe(true);
    expect(inTab(read, 'unread', NOW)).toBe(false);
    expect(inTab(read, 'all', NOW)).toBe(true);
    expect(inTab(mention, 'mentions', NOW)).toBe(true);
    expect(inTab(snoozed, 'unread', NOW)).toBe(false);
    expect(inTab(snoozed, 'snoozed', NOW)).toBe(true);
    expect(inTab(woke, 'unread', NOW)).toBe(true);
    expect(inTab(woke, 'snoozed', NOW)).toBe(false);
    expect(inTab(archived, 'all', NOW)).toBe(false);
  });

  it('counts unread per tab', () => {
    const rows = [
      row({ event: 'assigned', groupKey: 'a' }),
      row({ event: 'mentioned', groupKey: 'm', readAt: NOW }),
      row({ snoozedUntil: NOW + 5, groupKey: 's' }),
    ];
    const c = tabCounts(rows, NOW);
    expect(c.unread).toBe(1);
    expect(c.assigned).toBe(1);
    expect(c.mentions).toBe(0);
    expect(c.snoozed).toBe(1);
  });
});

describe('collapse', () => {
  it('folds a groupKey into one row, newest first, summing counts', () => {
    const older = row({ createdAt: NOW - 5000, count: 3, readAt: NOW });
    const newer = row({ createdAt: NOW - 10, count: 2 });
    const other = row({ groupKey: 't2:comment', ticketKey: 'ENG-7', createdAt: NOW - 100 });
    const gs = collapse([older, other, newer]);
    expect(gs.map((g) => g.head.id)).toEqual([newer.id, other.id]);
    expect(gs[0]!.ids).toEqual([newer.id, older.id]);
    expect(gs[0]!.count).toBe(5);
    expect(gs[0]!.unread).toBe(true);
  });

  it('never folds invitations together', () => {
    const a = row({
      event: 'invited',
      inviteId: 'i1',
      groupKey: 'x:invited',
      ticketId: null,
      ticketKey: null,
    });
    const b = row({
      event: 'invited',
      inviteId: 'i2',
      groupKey: 'x:invited',
      ticketId: null,
      ticketKey: null,
    });
    expect(collapse([a, b])).toHaveLength(2);
  });

  it('groupsForTab filters before folding', () => {
    const a = row({ readAt: NOW });
    const b = row();
    expect(groupsForTab([a, b], 'unread', NOW)[0]!.ids).toEqual([b.id]);
  });
});

describe('copy and links', () => {
  it('writes the one-line headline', () => {
    const g = collapse([row({ summary: 'mentioned you', count: 4, event: 'mentioned' })])[0]!;
    expect(rowHeadline(g, 'Priya')).toBe('Priya mentioned you · 3 more');
    const due = collapse([row({ actor: null, event: 'overdue', summary: '' })])[0]!;
    expect(rowHeadline(due, null)).toBe('Overdue');
  });

  it('links a ticket into its board, an invite to the invitations tab', () => {
    expect(boardKeyOf('ENG-42')).toBe('ENG');
    expect(rowHref({ event: 'comment', ticketKey: 'ENG-42' })).toBe('/b/ENG?ticket=ENG-42');
    expect(rowHref({ event: 'invited', ticketKey: null })).toBe('/inbox?tab=invitations');
  });

  it('formats compact times', () => {
    expect(timeAgo(NOW - 10_000, NOW)).toBe('now');
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe('5m');
    expect(timeAgo(NOW - 3 * 3_600_000, NOW)).toBe('3h');
    expect(timeAgo(NOW - 2 * 86_400_000, NOW)).toBe('2d');
  });
});

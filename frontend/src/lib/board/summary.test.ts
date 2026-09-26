/**
 * Phase 8 (§P2) — what a card says, and what it refuses to say.
 *
 * The rule under test is "empty facts are never drawn": no 'No tags', no zero
 * counts, nothing at all for a ticket with nothing to say. The other half is
 * the 💬 badge, which has to mean three different things (unread count, 'some
 * are new but we have not counted them', and a muted total) without ever
 * lying about whether something is new.
 */
import { describe, expect, it } from 'vitest';
import type { Board, Ticket } from '@tm/shared';
import {
  cardFacts,
  isBlocked,
  isUnread,
  unreadBadge,
  unreadTracked,
  type SummaryTicket,
} from './summary';

const NOW = Date.UTC(2026, 8, 24, 12, 0);
const DAY = 86_400_000;

const board = {
  stages: [{ id: 's1', name: 'To do', color: '#888', category: 'todo', position: 0 }],
  priorities: [{ id: 'p1', name: 'High', color: '#f00', position: 0 }],
  tags: [
    { id: 'g1', name: 'bug', color: '#0f0', position: 0 },
    { id: 'g2', name: 'ux', color: '#00f', position: 1 },
  ],
  fields: [
    {
      id: 'f1',
      name: 'Team',
      type: 'select',
      options: [{ id: 'o1', name: 'Core' }],
      position: 0,
      archived: false,
    },
  ],
} as unknown as Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields'>;

const EMPTY: SummaryTicket = {
  id: 't1',
  key: 'ENG-1',
  title: 'Nothing to say',
  state: 'active',
  stageId: 's1',
  stageCategory: 'todo',
  priorityId: null,
  tagIds: [],
  dueAt: null,
  dueAllDay: true,
  startAt: null,
  estimate: null,
  counts: { messages: 0, files: 0, pinned: 0 },
  lastMessageAt: null,
  assigneeUids: [],
  fields: {},
  links: [],
};

const ctx = (
  fields: readonly string[] | null,
  extra: Partial<Parameters<typeof cardFacts>[1]> = {},
) => ({
  board,
  tz: 'UTC',
  now: NOW,
  fields,
  ...extra,
});
const kinds = (t: SummaryTicket, fields: readonly string[] | null, extra = {}) =>
  cardFacts(t, ctx(fields, extra)).map((f) => f.kind);

describe('empty facts are never drawn (§P2)', () => {
  it('a ticket with nothing to say draws nothing — the card stays two lines', () => {
    const all = [
      'priority',
      'tag',
      'due',
      'start',
      'estimate',
      'stage',
      'tasks',
      'files',
      'blocked',
      'fields.f1',
    ];
    // 'stage' is the one thing every ticket has, so it is the only chip here.
    expect(kinds(EMPTY, all)).toEqual(['stage']);
    expect(kinds(EMPTY, null)).toEqual([]);
  });

  it('draws no chip for zero attachments and none for an empty task list', () => {
    expect(kinds({ ...EMPTY, counts: { messages: 3, files: 0, pinned: 0 } }, null)).toEqual([]);
    expect(kinds(EMPTY, null, { tasks: null })).toEqual([]);
  });

  it('skips a tag id the board no longer has, rather than drawing a blank chip', () => {
    expect(kinds({ ...EMPTY, tagIds: ['gone', 'g1'] }, ['tag'])).toEqual(['tag']);
  });

  it('skips a custom field the ticket has no value for', () => {
    expect(kinds({ ...EMPTY, fields: { f1: '' } }, ['fields.f1'])).toEqual([]);
    expect(kinds({ ...EMPTY, fields: { f1: 'o1' } }, ['fields.f1'])).toEqual(['field']);
  });
});

describe('the facts a card does draw', () => {
  const loaded: SummaryTicket = {
    ...EMPTY,
    priorityId: 'p1',
    tagIds: ['g1', 'g2'],
    dueAt: NOW - DAY,
    estimate: 3,
    counts: { messages: 2, files: 4, pinned: 0 },
    links: [{ type: 'blockedBy', ticketId: 't2' }] as Ticket['links'],
  };

  it('is in §P2 order: priority · tags · due · estimate · tasks · files · ⛔', () => {
    const facts = cardFacts(
      loaded,
      ctx(null, { blocked: true, tasks: { chip: '4/7', failed: 0, doing: null } }),
    );
    expect(facts.map((f) => f.kind)).toEqual([
      'priority',
      'tag',
      'tag',
      'due',
      'estimate',
      'tasks',
      'files',
      'blocked',
    ]);
  });

  it('colours the due chip red when it is overdue and amber when it is today', () => {
    const due = (at: number) => cardFacts({ ...EMPTY, dueAt: at }, ctx(['due']))[0];
    expect(due(NOW - DAY)?.tone).toBe('danger');
    expect(due(NOW + 3600_000)?.tone).toBe('warning');
    expect(due(NOW + 5 * DAY)?.tone).toBe('neutral');
  });

  it('a done ticket is not late, however old its due date', () => {
    const t = { ...EMPTY, dueAt: NOW - 30 * DAY, stageCategory: 'done' as const };
    expect(cardFacts(t, ctx(['due']))[0]?.tone).toBe('neutral');
  });

  it('turns the task chip red when something failed, and spins it while one runs', () => {
    const f = (tasks: { chip: string; failed: number; doing: string | null }) =>
      cardFacts(EMPTY, ctx(['tasks'], { tasks }))[0];
    expect(f({ chip: '4/7', failed: 1, doing: null })?.tone).toBe('danger');
    expect(f({ chip: '4/7', failed: 0, doing: 'Run the tests' })).toMatchObject({
      icon: 'tasksDoing',
      title: 'Run the tests',
    });
  });

  it('counts attachments and says so in the tooltip', () => {
    expect(cardFacts(loaded, ctx(['files']))[0]).toMatchObject({
      text: '4',
      title: '4 attachments',
    });
  });

  it('only draws the FIELDS the view asked for — but never drops a signal', () => {
    // 'files' is a signal: a view that asks for nothing still says there are
    // attachments, the same way it has always shown the task chip and ⛔.
    expect(kinds(loaded, ['priority'])).toEqual(['priority', 'files']);
    expect(
      kinds({ ...loaded, counts: { messages: 0, files: 0, pinned: 0 } }, ['priority']),
    ).toEqual(['priority']);
  });
});

describe('⛔ blocked', () => {
  const t = { ...EMPTY, links: [{ type: 'blockedBy', ticketId: 't2' }] as Ticket['links'] };
  const other = (stageCategory: string, state = 'active') =>
    new Map([['t2', { stageCategory, state } as Pick<Ticket, 'stageCategory' | 'state'>]]);

  it('blocks on an open ticket, and stops once it is done or cancelled', () => {
    expect(isBlocked(t, other('active'))).toBe(true);
    expect(isBlocked(t, other('done'))).toBe(false);
    expect(isBlocked(t, other('cancelled'))).toBe(false);
    expect(isBlocked(t, other('active', 'archived'))).toBe(false);
  });

  it('a blocker we cannot see still counts until someone unlinks it', () => {
    expect(isBlocked(t, new Map())).toBe(true);
  });

  it('other link types are not blocks', () => {
    expect(
      isBlocked({ links: [{ type: 'relates', ticketId: 't2' }] as Ticket['links'] }, new Map()),
    ).toBe(false);
  });
});

describe('the 💬 badge', () => {
  it('draws nothing for a ticket with no thread', () => {
    expect(unreadBadge(0, false, null)).toBeNull();
  });

  it('shows the count in accent when I have not read them', () => {
    expect(unreadBadge(9, true, 3)).toMatchObject({
      unread: true,
      text: '3',
      label: '3 unread messages',
    });
    expect(unreadBadge(9, true, 1)).toMatchObject({ text: '1', label: '1 unread message' });
  });

  it("says '20+' rather than pretending to have counted them all", () => {
    expect(unreadBadge(300, true, 20, true)).toMatchObject({ unread: true, text: '20+' });
  });

  it('falls back to the total, still in accent, while the count is unknown', () => {
    expect(unreadBadge(9, true, null)).toMatchObject({ unread: true, text: '9' });
  });

  it('is a muted total once everything is read', () => {
    expect(unreadBadge(9, false, null)).toMatchObject({
      unread: false,
      text: '9',
      label: '9 messages',
    });
  });

  it('is muted when the only new messages are mine (count came back zero)', () => {
    expect(unreadBadge(9, true, 0)).toMatchObject({ unread: false, text: '9' });
  });
});

describe('the read pointer decides', () => {
  const t = {
    id: 't1',
    lastMessageAt: 500,
    watcherUids: ['me'],
    counts: { messages: 2, files: 0, pinned: 0 },
  };

  it('is unread when something arrived after my pointer', () => {
    expect(isUnread(t, 400, 'me')).toBe(true);
    expect(isUnread(t, 500, 'me')).toBe(false);
    expect(isUnread(t, 900, 'me')).toBe(false);
  });

  it('a ticket I never opened is unread only if I watch it', () => {
    expect(isUnread(t, null, 'me')).toBe(true);
    expect(isUnread(t, null, 'someone')).toBe(false);
  });

  it('a thread with no messages is never unread', () => {
    expect(isUnread({ ...t, lastMessageAt: null }, null, 'me')).toBe(false);
  });

  it('tracks only unread tickets, newest first, up to the cap', () => {
    const rows = [1, 2, 3].map((n) => ({ ...t, id: `t${n}`, lastMessageAt: n * 100 }));
    rows.push({ ...t, id: 'read', lastMessageAt: 999 });
    const tracked = unreadTracked(rows, (id) => (id === 'read' ? 1000 : 0), 'me', 2);
    expect([...tracked]).toEqual(['t3', 't2']);
  });

  it('never tracks a ticket with no thread at all', () => {
    const rows = [{ ...t, counts: { messages: 0, files: 0, pinned: 0 } }];
    expect(unreadTracked(rows, () => null, 'me', 10).size).toBe(0);
  });
});

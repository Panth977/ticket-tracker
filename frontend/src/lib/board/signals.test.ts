/**
 * §W — a card's signals, read off the ticket document. There is no listener
 * left to stub: every function here is (ticket) → (what the card draws).
 */
import { describe, expect, it } from 'vitest';
import type { Question, StoredMessage, StoredTasklist, Ticket } from '@tm/shared';
import {
  questionSignalOfTicket,
  tasklistSignalOfTicket,
  unreadOfTicket,
  UNREAD_WINDOW,
} from './signals';

const NOW = Date.UTC(2026, 8, 23, 10, 0);

const list = (id: string, statuses: string[]): StoredTasklist =>
  ({
    id,
    title: 'Plan',
    owner: 'ag_0000000000000001',
    items: statuses.map((s, i) => ({
      id: `i${i}`,
      title: `t${i}`,
      status: s as never,
      updatedAt: NOW,
    })),
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
  }) as unknown as StoredTasklist;

/** A §W ticket: the inline arrays plus whatever rollup the test is about. */
const ticket = (over: Partial<Ticket> = {}): Ticket =>
  ({
    tasklists: [],
    files: [],
    recentMessages: [],
    recentActivity: [],
    pageCount: 0,
    oldestInlineAt: null,
    waitingOn: null,
    tasklistProgress: null,
    ...over,
  }) as unknown as Ticket;

describe('tasklistSignalOfTicket — the 4/7 chip', () => {
  it('reads §W’s rollup, including which item is running', () => {
    const t = ticket({
      signals: { tasklist: { done: 3, total: 5, working: 'compile' } } as Ticket['signals'],
      tasklists: [list('l1', ['done', 'done', 'todo']), list('l2', ['done', 'doing'])],
    });
    expect(tasklistSignalOfTicket(t)).toMatchObject({
      chip: '3/5',
      settled: 3,
      total: 5,
      doing: 'compile',
    });
  });

  it('sums the inline lists when the rollup is not there yet', () => {
    const t = ticket({ tasklists: [list('l1', ['done', 'done', 'todo'])] });
    expect(tasklistSignalOfTicket(t)).toMatchObject({ chip: '2/3', settled: 2, total: 3 });
  });

  it('flags failures so the chip can go red', () => {
    const t = ticket({ tasklists: [list('l1', ['failed', 'done'])] });
    expect(tasklistSignalOfTicket(t)?.failed).toBe(1);
  });

  it('draws nothing for a ticket with no items at all', () => {
    expect(tasklistSignalOfTicket(ticket())).toBeNull();
    expect(tasklistSignalOfTicket(ticket({ tasklists: [list('l1', [])] }))).toBeNull();
  });

  it('still reads the phase-3 field on a ticket the migration has not folded', () => {
    const t = { tasklistProgress: { done: 1, total: 4 } } as unknown as Ticket;
    expect(tasklistSignalOfTicket(t)).toMatchObject({ chip: '1/4', doing: null });
  });
});

const question = (over: Partial<Question> = {}): Question =>
  ({
    title: 'Which database?',
    body: null,
    fields: [{ id: 'db', label: 'Database', type: 'text' }],
    allowComment: false,
    to: null,
    blocking: true,
    status: 'open',
    expiresAt: null,
    answer: null,
    ...over,
  }) as Question;

const waiting = (over: Partial<NonNullable<Ticket['waitingOn']>> = {}) =>
  ({
    count: 1,
    messageId: 'm1',
    title: question().title,
    to: null,
    askedBy: 'u9',
    askedAt: NOW - 1000,
    expiresAt: null,
    ...over,
  }) as NonNullable<Ticket['waitingOn']>;

describe('questionSignalOfTicket — the ❓ badge', () => {
  it('is for me when the question is addressed to nobody in particular', () => {
    const s = questionSignalOfTicket(ticket({ waitingOn: waiting({ count: 2 }) }), 'u1', NOW);
    expect(s).toMatchObject({ open: 2, waiting: 2, title: 'Which database?' });
  });

  it('is somebody else’s when it names other people', () => {
    const s = questionSignalOfTicket(ticket({ waitingOn: waiting({ to: ['u2'] }) }), 'u1', NOW);
    expect(s).toMatchObject({ open: 1, waiting: 0 });
  });

  it('goes away on the clock, not on the next write', () => {
    const t = ticket({ waitingOn: waiting({ expiresAt: NOW - 1 }) });
    expect(questionSignalOfTicket(t, 'u1', NOW)).toBeNull();
  });

  it('draws nothing when nothing is open', () => {
    expect(questionSignalOfTicket(ticket(), 'u1', NOW)).toBeNull();
  });
});

// ─────────────────────── §W2: unread with no query ──────────────────────────

const msg = (id: string, createdAt: number, authorUid: string | null): StoredMessage =>
  ({ id, createdAt, authorUid, kind: 'comment', deletedAt: null }) as unknown as StoredMessage;

describe('unreadOfTicket — counted from the inline window', () => {
  const thread = [
    msg('m1', NOW - 5000, 'u2'),
    msg('m2', NOW - 4000, 'u1'),
    msg('m3', NOW - 3000, 'u2'),
    msg('m4', NOW - 2000, 'u2'),
  ];
  const t = (over: Partial<Ticket> = {}) =>
    ticket({
      recentMessages: thread,
      signals: { unreadFrom: thread[0]!.createdAt } as Ticket['signals'],
      ...over,
    });

  it('counts what is newer than my pointer and not mine', () => {
    expect(unreadOfTicket(t(), NOW - 4500, 'u1')).toEqual({ count: 2, capped: false });
  });

  it('counts the whole thread for a ticket I have never opened', () => {
    expect(unreadOfTicket(t({ counts: { messages: 4 } as never }), 0, 'u1')).toEqual({
      count: 3,
      capped: false,
    });
  });

  it('opens nothing and says nothing when the board is not counting this card', () => {
    expect(unreadOfTicket(t(), null, 'u1')).toBeNull();
  });

  it('ignores my own messages and tombstones', () => {
    const deleted = { ...msg('m5', NOW - 1000, 'u2'), deletedAt: NOW } as StoredMessage;
    expect(unreadOfTicket(t({ recentMessages: [...thread, deleted] }), NOW - 1500, 'u1')).toEqual({
      count: 0,
      capped: false,
    });
  });

  it('says "at least this many" when my pointer predates a thread that spilled', () => {
    // 900 messages, four of them inline: the rest are in data/{NNN}.
    const c = unreadOfTicket(t({ counts: { messages: 900 } as never }), NOW - 6000, 'u1');
    expect(c).toEqual({ count: 3, capped: true });
  });

  it('caps at the window', () => {
    const many = Array.from({ length: UNREAD_WINDOW + 5 }, (_, i) =>
      msg(`x${i}`, NOW - 100_000 + i, 'u2'),
    );
    const c = unreadOfTicket(
      ticket({
        recentMessages: many,
        counts: { messages: many.length } as never,
        signals: { unreadFrom: many[0]!.createdAt } as never,
      }),
      NOW - 200_000,
      'u1',
    );
    expect(c).toEqual({ count: UNREAD_WINDOW, capped: true });
  });

  it('cannot count a ticket written before §W folded its thread in', () => {
    expect(unreadOfTicket({}, 0, 'u1')).toBeNull();
  });
});

describe('unreadOfTicket — a Drive board’s list answer (meta.json + unread tail)', () => {
  const tail = [
    { id: 'm1', createdAt: NOW - 5000, authorUid: 'u2', deletedAt: null },
    { id: 'm2', createdAt: NOW - 4000, authorUid: 'u1', deletedAt: null },
    { id: 'm3', createdAt: NOW - 3000, authorUid: 'u2', deletedAt: null },
    { id: 'm4', createdAt: NOW - 2000, authorUid: 'u2', deletedAt: NOW },
  ];
  // The list has no thread; its signals still say where the 40-message window starts.
  const listed = (over: Partial<Ticket> = {}) =>
    ticket({
      recentMessages: [],
      unreadTail: tail,
      counts: { messages: 4 } as never,
      signals: { unreadFrom: NOW - 90_000, messageCount: 4 } as never,
      ...over,
    });

  it('counts from the tail: not mine, not deleted', () => {
    expect(unreadOfTicket(listed(), NOW - 4500, 'u1')).toEqual({ count: 1, capped: false });
  });

  it('says "at least" when my pointer is older than the tail of a longer thread', () => {
    const c = unreadOfTicket(
      listed({ counts: { messages: 60 } as never, signals: { messageCount: 60 } as never }),
      NOW - 60_000,
      'u1',
    );
    expect(c).toEqual({ count: 2, capped: true });
  });

  it('is unknown (not zero) for a listed ticket with messages but no tail yet', () => {
    expect(unreadOfTicket(listed({ unreadTail: undefined }), 0, 'u1')).toBeNull();
  });

  it('prefers the thread itself when the ticket was read whole', () => {
    const whole = listed({
      recentMessages: [msg('m8', NOW - 200, 'u2'), msg('m9', NOW - 100, 'u2')],
      counts: { messages: 2 } as never,
      signals: { unreadFrom: NOW - 200, messageCount: 2 } as never,
    });
    expect(unreadOfTicket(whole, NOW - 4500, 'u1')).toEqual({ count: 2, capped: false });
  });
});

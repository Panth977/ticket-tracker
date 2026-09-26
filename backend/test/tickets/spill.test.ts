/**
 * The §W arithmetic, without a database: what stays inline, what spills, and
 * what the card's signals say. It is pure (shared/src/schema/ticket.ts), so
 * the migration and the command layer are provably doing the same fold.
 */
import { describe, expect, it } from 'vitest';
import {
  INLINE_CUT_BYTES,
  KEEP_INLINE_MESSAGES,
  MAX_INLINE_MESSAGES,
  docBytes,
  planSpill,
  questionRollup,
  signalsOf,
  tasklistRollup,
  type StoredMessage,
  type StoredTasklist,
  type Ticket,
} from '@tm/shared';
import { fixtures } from '@tm/shared/schema/fixtures';

const NOW = Date.UTC(2026, 8, 26, 12);

const msg = (i: number, over: Partial<StoredMessage> = {}): StoredMessage => ({
  id: `m${String(i).padStart(5, '0')}`,
  kind: 'comment',
  body: { doc: { type: 'doc', content: [] }, text: `note ${i}`, mentions: [], refs: [] },
  authorUid: 'u_1',
  authorName: 'A',
  via: 'app',
  replyTo: null,
  attachments: [],
  reactions: {},
  pinnedAt: null,
  pinnedBy: null,
  editedAt: null,
  deletedAt: null,
  createdAt: NOW + i,
  ...over,
});

const thread = (n: number) => Array.from({ length: n }, (_, i) => msg(i + 1));

describe('planSpill', () => {
  it('leaves a short thread alone', () => {
    const p = planSpill(thread(10), [], 1_000, 0, NOW);
    expect(p.pages).toEqual([]);
    expect(p.messages).toHaveLength(10);
  });

  it('spills the OLDEST chunk once the thread passes the cut, keeping the newest inline', () => {
    const p = planSpill(thread(MAX_INLINE_MESSAGES + 1), [], 1_000, 0, NOW);
    expect(p.pages).toHaveLength(1);
    expect(p.messages).toHaveLength(KEEP_INLINE_MESSAGES);
    // page 000 holds the oldest, the inline window the newest — in order.
    expect(p.pages[0]!.doc.messages[0]!.id).toBe('m00001');
    expect(p.pages[0]!.page).toBe(0);
    const all = [...p.pages.flatMap((x) => x.doc.messages), ...p.messages];
    expect(all).toHaveLength(MAX_INLINE_MESSAGES + 1);
    // pages then inline IS the thread in order
    expect(all.map((m) => m.id)).toEqual(thread(MAX_INLINE_MESSAGES + 1).map((m) => m.id));
  });

  it('pages 2,000 messages in order, and every page is under the cut', () => {
    const msgs = thread(2_000);
    const pages = [];
    // Post them one at a time, the way the thread actually grows.
    let inline: StoredMessage[] = [];
    for (const m of msgs) {
      const p = planSpill([...inline, m], [], 5_000, pages.length, NOW);
      pages.push(...p.pages);
      inline = p.messages;
    }
    const all = [...pages.flatMap((p) => p.doc.messages), ...inline];
    expect(all).toHaveLength(2_000);
    expect(all.map((m) => m.id)).toEqual(msgs.map((m) => m.id)); // order preserved
    expect(pages.map((p) => p.page)).toEqual(pages.map((_, i) => i)); // 000, 001, …
    for (const p of pages) expect(docBytes(p.doc)).toBeLessThan(INLINE_CUT_BYTES);
    expect(inline.length).toBeLessThanOrEqual(MAX_INLINE_MESSAGES);
  });

  it('keeps a pinned message and an open question inline', () => {
    const pinned = msg(1, { pinnedAt: NOW });
    const question = msg(2, {
      kind: 'question',
      question: {
        title: 'Which database?',
        body: null,
        fields: [{ id: 'f', label: 'Pick', type: 'text' }],
        allowComment: false,
        to: null,
        blocking: true,
        status: 'open',
        expiresAt: null,
        answer: null,
        cancelledAt: null,
      },
    });
    const p = planSpill([pinned, question, ...thread(400).slice(2)], [], 1_000, 0, NOW);
    const ids = p.messages.map((m) => m.id);
    expect(ids).toContain(pinned.id);
    expect(ids).toContain(question.id);
    // Nothing spilled, because the oldest run is pinned in place.
    expect(p.pages).toEqual([]);
  });

  it('ignores the pin rather than letting the document grow past the cut', () => {
    const big = 'x'.repeat(20_000);
    const heavy = thread(60).map((m, i) => ({
      ...m,
      pinnedAt: i < 5 ? NOW : null,
      body: { ...m.body, text: big },
    }));
    const p = planSpill(heavy, [], 1_000, 0, NOW);
    expect(p.pages.length).toBeGreaterThan(0);
    expect(docBytes(p.messages)).toBeLessThan(INLINE_CUT_BYTES);
  });
});

describe('signals', () => {
  const base = fixtures.tickets as Ticket;

  it('unreadFrom is the oldest inline message — what a card counts from', () => {
    const t: Ticket = {
      ...base,
      recentMessages: thread(5),
      counts: { ...base.counts, messages: 5 },
    };
    expect(signalsOf(t).unreadFrom).toBe(NOW + 1);
    expect(signalsOf(t).messageCount).toBe(5);
    expect(signalsOf({ ...base, recentMessages: [] }).unreadFrom).toBeNull();
  });

  it('blocked: a blocking question, or another ticket in the way', () => {
    expect(signalsOf({ ...base, waitingOn: null, links: [] }).blocked).toBe(false);
    expect(
      signalsOf({ ...base, waitingOn: null, links: [{ type: 'blockedBy', ticketId: 'tkt_x' }] })
        .blocked,
    ).toBe(true);
  });

  it('tasklist rolls every list up, and names the item being worked on', () => {
    const list = (id: string, statuses: string[]): StoredTasklist => ({
      id,
      title: id,
      owner: 'u_1',
      position: 0,
      createdAt: NOW,
      updatedAt: NOW,
      closedAt: null,
      items: statuses.map((s, i) => ({
        id: `${id}${i}`,
        title: `${id} item ${i}`,
        status: s as 'todo',
        updatedAt: NOW,
      })),
    });
    const r = tasklistRollup([list('a', ['done', 'doing', 'todo']), list('b', ['skipped'])])!;
    // settled = done + skipped: 'done' in a, 'skipped' in b.
    expect(r).toEqual({ done: 2, total: 4, working: 'a item 1' });
    expect(tasklistRollup([])).toBeNull();
  });
});

describe('questionRollup', () => {
  const ask = (id: string, over: Record<string, unknown> = {}) =>
    msg(1, {
      id,
      kind: 'question',
      createdAt: NOW + Number(id.slice(1)),
      question: {
        title: `Q ${id}`,
        body: null,
        fields: [{ id: 'f', label: 'Pick', type: 'text' }],
        allowComment: false,
        to: null,
        blocking: true,
        status: 'open',
        expiresAt: null,
        answer: null,
        cancelledAt: null,
        ...over,
      },
    });

  it('names the OLDEST open blocking question and counts them all', () => {
    const r = questionRollup([ask('m2'), ask('m1')], NOW, null);
    expect(r.waitingOn).toMatchObject({ messageId: 'm1', count: 2 });
  });

  it('drops answered / expired ones and reports the earliest expiry', () => {
    const r = questionRollup(
      [ask('m1', { status: 'answered' }), ask('m2', { expiresAt: NOW + 5_000 })],
      NOW,
      null,
    );
    expect(r.waitingOn).toMatchObject({ messageId: 'm2', count: 1 });
    expect(r.nextQuestionExpiresAt).toBe(NOW + 5_000);
    expect(questionRollup([ask('m1', { status: 'cancelled' })], NOW, null)).toEqual({
      waitingOn: null,
      nextQuestionExpiresAt: null,
    });
  });

  it('keeps a still-open question that spilled out of the inline window', () => {
    const carry = {
      count: 1,
      messageId: 'gone',
      title: 'Old question',
      to: null,
      askedBy: 'u_1',
      askedAt: NOW - 1,
      expiresAt: null,
    };
    expect(questionRollup([], NOW, carry).waitingOn).toMatchObject({ messageId: 'gone' });
    // …but not once the thread still holds it and it is settled.
    expect(questionRollup([ask('gone', { status: 'answered' })], NOW, carry).waitingOn).toBeNull();
  });
});

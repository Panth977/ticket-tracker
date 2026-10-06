import { describe, expect, it } from 'vitest';
import { AGENT_ID, fixtures, questionMessageFixture, UID_ASHA } from '../schema/fixtures.js';
import type { StoredMessage } from '../schema/message.js';
import type { AggStats } from '../schema/aggregates.js';
import { planAggregates, toDriverAggCounters, toDriverAggregates } from './aggregates.js';
import { planThread, readThread, toDriverMessage } from './thread.js';
import { toDriverBoard, toDriverPerson, toDriverTicket } from './tickets.js';

const people = new Map(
  [
    { uid: UID_ASHA, kind: 'user' as const, name: 'Asha', email: 'asha@example.com' },
    { uid: AGENT_ID, kind: 'agent' as const, name: 'Builder', email: '' },
  ].map((m) => [m.uid, toDriverPerson(m)]),
);
const FIELDS = [
  { id: 'cost', label: 'Cost', unit: '$' },
  { id: 'a_hours1', label: 'Time', unit: 'h' },
];
const msg = (id: string, at: number, o: Partial<StoredMessage> = {}): StoredMessage => ({
  ...fixtures.messages,
  id,
  createdAt: at,
  markdown: `m ${id}`,
  ...o,
});

describe('§K a thread as an artifact sees it', () => {
  it('a comment: author by name, Markdown, attachments without paths', () => {
    const m = toDriverMessage(msg('m1', 5, { markdown: null }), people, FIELDS);
    expect(m).toMatchObject({
      id: 'm1',
      kind: 'comment',
      author: { id: UID_ASHA, name: 'Asha', kind: 'user' },
      deleted: false,
      pinned: false,
      replyTo: null,
      attachments: [{ id: 'att_1', name: 'screenshot.png', mime: 'image/png', size: 12345 }],
    });
    expect(m.markdown.length).toBeGreaterThan(0);
    expect(JSON.stringify(m)).not.toContain('boards/'); // never a storage path
    expect(m.question).toBeUndefined();
    expect(m.agg).toBeUndefined();
  });

  it('a tombstone keeps its place, emptied', () => {
    const m = toDriverMessage(msg('m2', 6, { deletedAt: 7 }), people, FIELDS);
    expect(m).toMatchObject({ deleted: true, markdown: '', attachments: [] });
  });

  it('agg entries get their field’s label and unit; `at` when the message has one', () => {
    const m = toDriverMessage(
      msg('m3', 8, {
        kind: 'agg',
        agg: {
          entries: [
            { fieldId: 'a_hours1', value: 2.5 },
            { fieldId: 'a_gone00', value: -1 },
          ],
          at: 3,
        } as never,
      }),
      people,
      FIELDS,
    );
    expect(m.agg).toEqual({
      at: 3,
      entries: [
        { fieldId: 'a_hours1', label: 'Time', unit: 'h', value: 2.5 },
        { fieldId: 'a_gone00', label: 'a_gone00', unit: '', value: -1 },
      ],
    });
  });

  it('a turn receipt and a question card (answer by field label, choices by label)', () => {
    const run = toDriverMessage(
      msg('m4', 9, {
        authorUid: AGENT_ID,
        run: {
          n: 3,
          outcome: 'review',
          costUsd: 1.24,
          sessionUsd: null,
          durationMs: 720000,
          apiTurns: 4,
          model: 'claude',
          usage: null,
        },
      }),
      people,
      FIELDS,
    );
    expect(run.author).toMatchObject({ kind: 'agent', name: 'Builder' });
    expect(run.run).toEqual({
      n: 3,
      outcome: 'review',
      costUsd: 1.24,
      durationMs: 720000,
      model: 'claude',
    });
    const q = toDriverMessage(
      {
        ...questionMessageFixture,
        id: 'q1',
        question: {
          ...questionMessageFixture.question!,
          status: 'answered',
          answer: { values: { f_db: 'o_pg', f_note: 'careful' }, by: UID_ASHA, at: 11 },
        },
      },
      people,
      FIELDS,
    );
    expect(q.question).toMatchObject({
      title: 'Which database should the report use?',
      status: 'answered',
      fields: [
        {
          id: 'f_db',
          label: 'Database',
          type: 'single',
          required: true,
          options: ['Postgres', 'BigQuery'],
        },
        { id: 'f_note', required: false },
      ],
      answer: {
        values: { Database: 'Postgres', 'Anything to watch out for?': 'careful' },
        comment: null,
        by: { id: UID_ASHA, name: 'Asha' },
        at: 11,
      },
    });
  });

  it('planThread: default 50, at most 200; before is an id or millis; live refuses before', () => {
    expect(planThread(undefined)).toEqual({ limit: 50, before: null });
    expect(planThread({ limit: 999 }).limit).toBe(200);
    expect(planThread({ before: 'm1' }).before).toEqual({ id: 'm1' });
    expect(planThread({ before: 5 }).before).toEqual({ at: 5 });
    expect(() => planThread({ before: 5 }, true)).toThrow(/thread\(\)/);
    expect(() => planThread({ before: {} as never })).toThrow(/before/);
  });

  it('readThread: inline first, pages from the newest back only as far as needed', async () => {
    const pages: Record<number, StoredMessage[]> = {
      0: [msg('a', 1), msg('b', 2)],
      1: [msg('c', 3), msg('d', 4)],
    };
    const ticket = { recentMessages: [msg('f', 6), msg('e', 5)], pageCount: 2 };
    const asked: number[] = [];
    const page = async (n: number) => (asked.push(n), pages[n] ?? null);
    const ids = (ms: StoredMessage[]) => ms.map((m) => m.id);

    expect(ids(await readThread(ticket, planThread({ limit: 2 }), page))).toEqual(['e', 'f']);
    expect(asked).toEqual([]); // the inline window was enough: no page read
    expect(ids(await readThread(ticket, planThread({ limit: 3 }), page))).toEqual(['d', 'e', 'f']);
    expect(asked).toEqual([1]);
    asked.length = 0;
    expect(ids(await readThread(ticket, planThread({ before: 'd', limit: 2 }), page))).toEqual([
      'b',
      'c',
    ]);
    expect(ids(await readThread(ticket, planThread({ before: 3 }), page))).toEqual(['a', 'b']);
    await expect(readThread(ticket, planThread({ before: 'zz' }), page)).rejects.toThrow(
      /No message zz/,
    );
  });
});

describe('§K aggregates as an artifact sees them', () => {
  const board = {
    ...fixtures.boards,
    id: 'b1',
    aggFields: [
      { id: 'cost', label: 'Cost', unit: '$', period: 'daily' as const, position: 0 },
      { id: 'a_hours1', label: 'Time', unit: 'h', period: 'weekly' as const, position: 1 },
      {
        id: 'a_old000',
        label: 'Old',
        unit: '',
        period: 'monthly' as const,
        position: 2,
        archived: true,
      },
    ],
    aggs: { cost: { total: 9.5, count: 4 }, a_hours1: { total: 12, count: 3 } },
  };
  const NOW = Date.UTC(2026, 9, 6, 6); // 2026-10-06, midday in AGG_TZ

  it('board and ticket carry their fields and counters (legacy cost mirrored)', () => {
    const b = toDriverBoard(board, 'read', false, []);
    expect(b.aggFields.map((f) => [f.id, f.period, f.archived])).toEqual([
      ['cost', 'daily', false],
      ['a_hours1', 'weekly', false],
      ['a_old000', 'monthly', true],
    ]);
    expect(b.aggs).toEqual({ cost: { total: 9.5, count: 4 }, a_hours1: { total: 12, count: 3 } });
    expect(toDriverAggCounters({ cost: { usd: 2, runs: 1 } })).toEqual({
      cost: { total: 2, count: 1 },
    });
    const t = toDriverTicket(
      board,
      { ...fixtures.tickets, id: 't1', boardId: 'b1', aggs: { a_hours1: { total: 2, count: 1 } } },
      new Map(),
      'https://x',
    );
    expect(t.aggs).toEqual({ a_hours1: { total: 2, count: 1 } });
  });

  it('planAggregates: field by id or label, REST defaults, keys checked', () => {
    const p = planAggregates(board, undefined, NOW);
    expect(p.field.id).toBe('cost');
    expect(p.from).toBe('2026-09-07'); // 30 days ending today
    expect(p.to).toBeNull();
    expect(planAggregates(board, { field: 'time' }, NOW).from).toBe('2026-W30');
    expect(planAggregates(board, { field: 'a_old000' }, NOW).field.label).toBe('Old');
    expect(() => planAggregates(board, { field: 'Nope' }, NOW)).toThrow(/have: Cost, Time, Old/);
    expect(() => planAggregates(board, { from: '2026-W01' }, NOW)).toThrow(/daily key/);
    expect(() => planAggregates(board, { from: '2026-10-02', to: '2026-10-01' }, NOW)).toThrow(
      /after/,
    );
  });

  it('toDriverAggregates: the field’s period and range only, oldest first, summed', () => {
    const doc = (period: AggStats['period'], key: string, fields: AggStats['fields']) => ({
      period,
      key,
      fields,
    });
    const docs = [
      doc('daily', '2026-10-02', {
        cost: { total: 1.5, count: 2, tickets: { 'ENG-1': { total: 1.5, count: 2 } } },
      }),
      doc('daily', '2026-09-01', { cost: { total: 7, count: 1, tickets: {} } }), // before from
      doc('daily', '2026-10-01', {
        cost: { total: 0.25, count: 1, tickets: { 'ENG-2': { total: 0.25, count: 1 } } },
      }),
      doc('weekly', '2026-W40', { a_hours1: { total: 3, count: 1, tickets: {} } }),
    ];
    const r = toDriverAggregates(board, planAggregates(board, { field: 'Cost' }, NOW), docs);
    expect(r).toEqual({
      field: { id: 'cost', label: 'Cost', unit: '$', period: 'daily', archived: false },
      from: '2026-09-07',
      to: null,
      total: 1.75,
      count: 3,
      lifetime: { total: 9.5, count: 4 },
      buckets: [
        {
          key: '2026-10-01',
          total: 0.25,
          count: 1,
          tickets: { 'ENG-2': { total: 0.25, count: 1 } },
        },
        { key: '2026-10-02', total: 1.5, count: 2, tickets: { 'ENG-1': { total: 1.5, count: 2 } } },
      ],
    });
    const w = toDriverAggregates(board, planAggregates(board, { field: 'Time' }, NOW), docs);
    expect(w.buckets.map((b) => b.key)).toEqual(['2026-W40']);
    expect(w.lifetime).toEqual({ total: 12, count: 3 });
  });
});

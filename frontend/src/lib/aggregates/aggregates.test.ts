import { describe, expect, it } from 'vitest';
import { COST_AGG_FIELD, type AggFieldDef, type AggStats } from '@tm/shared';
import {
  activeAggFields,
  aggCountersOf,
  aggFieldId,
  cardChips,
  draftEntries,
  parseAggValue,
  periodLocked,
  ticketChips,
} from './fields';
import {
  addPeriods,
  bucketsOf,
  fillBuckets,
  longBucket,
  periodKeys,
  periodTiles,
  rankBucketTickets,
  shortBucket,
  sumBuckets,
  weekMonday,
} from './periods';

const TIME: AggFieldDef = {
  id: 'a_time01',
  label: 'Time',
  unit: 'h',
  period: 'weekly',
  position: 1,
  showOnCard: true,
};
const PTS: AggFieldDef = {
  id: 'a_pts001',
  label: 'Points',
  unit: 'pts',
  period: 'monthly',
  position: 2,
};

describe('fields', () => {
  it('a legacy board (no aggFields) reads as Cost, from its legacy counter', () => {
    const board = { cost: { usd: 4.5, runs: 3 } };
    expect(activeAggFields(board).map((f) => f.id)).toEqual(['cost']);
    expect(aggCountersOf(board)).toEqual({ cost: { total: 4.5, count: 3 } });
    expect(cardChips(board, aggCountersOf(board))[0]).toMatchObject({
      text: '$4.50',
      title: 'Cost: $4.50 · 3 entries',
    });
  });

  it('aggs wins over the legacy mirror; archived fields are not drawn', () => {
    const board = {
      aggFields: [COST_AGG_FIELD, TIME, { ...PTS, archived: true }],
      cost: { usd: 1, runs: 1 },
      aggs: {
        cost: { total: 2, count: 2 },
        a_time01: { total: 2.5, count: 2 },
        a_pts001: { total: 9, count: 1 },
      },
    };
    const c = aggCountersOf(board);
    expect(c.cost).toEqual({ total: 2, count: 2 });
    expect(cardChips(board, c).map((x) => x.text)).toEqual(['$2.00', '2.5 h']);
    expect(ticketChips(board, c).map((x) => x.id)).toEqual(['cost', 'a_time01']);
    expect(periodLocked(board, 'a_time01')).toBe(true);
    expect(periodLocked(board, 'a_new123')).toBe(false);
  });

  it('a zero total is no chip; a net-negative one is', () => {
    const board = { aggFields: [TIME] };
    expect(cardChips(board, { a_time01: { total: 0, count: 2 } })).toEqual([]);
    expect(cardChips(board, { a_time01: { total: -1, count: 1 } })[0]!.text).toBe('-1 h');
  });

  it('new field ids match the contract and avoid taken ones', () => {
    const id = aggFieldId(['a_aaaaaa']);
    expect(id).toMatch(/^a_[a-z0-9]{6}$/);
  });

  it('reads numbers as people type them', () => {
    expect(parseAggValue('2.5')).toBe(2.5);
    expect(parseAggValue('−0.5')).toBe(-0.5);
    expect(parseAggValue('+3')).toBe(3);
    expect(parseAggValue('1,250.75')).toBe(1250.75);
    expect(parseAggValue('  ')).toBeNull();
    expect(parseAggValue('abc')).toBeNaN();
  });

  it('the composer dialog: blank and zero rows skipped, bad ones reported', () => {
    expect(
      draftEntries([
        { fieldId: 'cost', raw: '' },
        { fieldId: 'a_time01', raw: '2.5' },
      ]),
    ).toEqual({
      entries: [{ fieldId: 'a_time01', value: 2.5 }],
      errors: {},
      ok: true,
    });
    expect(draftEntries([{ fieldId: 'cost', raw: '0' }]).ok).toBe(false);
    const bad = draftEntries([
      { fieldId: 'cost', raw: 'x' },
      { fieldId: 'a_time01', raw: '1e13' },
    ]);
    expect(bad.errors).toEqual({ cost: 'Not a number', a_time01: 'Too large' });
    expect(bad.ok).toBe(false);
  });
});

describe('periods', () => {
  // 2026-10-05 12:00 IST is a Monday of ISO week 41.
  const NOW = Date.parse('2026-10-05T06:30:00Z');

  it('ranges end on the current bucket, ascending', () => {
    expect(periodKeys('daily', NOW, 3)).toEqual(['2026-10-03', '2026-10-04', '2026-10-05']);
    expect(periodKeys('weekly', NOW, 3)).toEqual(['2026-W39', '2026-W40', '2026-W41']);
    expect(periodKeys('monthly', NOW, 3)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(periodKeys('monthly', NOW, 12)[0]).toBe('2025-11');
    expect(periodKeys('daily', NOW, 90)).toHaveLength(90);
  });

  it('steps weeks across a year (2026 has 53 ISO weeks)', () => {
    expect(addPeriods('weekly', '2027-W01', -1)).toBe('2026-W53');
    expect(addPeriods('weekly', '2026-W53', 1)).toBe('2027-W01');
    expect(weekMonday('2026-W41')).toBe('2026-10-05');
    expect(addPeriods('monthly', '2026-01', -1)).toBe('2025-12');
  });

  const docs: Pick<AggStats, 'key' | 'fields'>[] = [
    {
      key: '2026-W41',
      fields: { a_time01: { total: 2, count: 2, tickets: { 'E-1': { total: 2, count: 2 } } } },
    },
    {
      key: '2026-W39',
      fields: {
        a_time01: { total: 5, count: 1, tickets: { 'E-2': { total: 5, count: 1 } } },
        a_other1: { total: 1, count: 1, tickets: {} },
      },
    },
    { key: '2026-W40', fields: { a_other1: { total: 7, count: 1, tickets: {} } } },
  ];

  it('a doc holds every field of its period: one field is picked out, then filled', () => {
    const rows = bucketsOf(docs, 'a_time01');
    expect(rows.map((r) => r.key)).toEqual(['2026-W39', '2026-W41']);
    const slots = fillBuckets(rows, periodKeys('weekly', NOW, 3));
    expect(slots.map((s) => s?.total ?? null)).toEqual([5, null, 2]);
    expect(sumBuckets(rows)).toEqual({ total: 7, count: 3, tickets: 2 });
    expect(rankBucketTickets(rows).map((t) => t.key)).toEqual(['E-2', 'E-1']);
  });

  it('tiles per period', () => {
    const rows = bucketsOf(docs, 'a_time01');
    const t = periodTiles('weekly', rows, '2026-W41');
    expect(t.map((x) => [x.id, x.sum.total])).toEqual([
      ['recent', 7],
      ['current', 2],
    ]);
    expect(periodTiles('daily', [], '2026-10-05').map((x) => x.label)).toEqual([
      'This month',
      'Last 7 days',
      'Today',
    ]);
  });

  it('labels', () => {
    expect(shortBucket('weekly', '2026-W41')).toBe('W41');
    expect(shortBucket('monthly', '2026-10')).toBe('Oct');
    expect(longBucket('monthly', '2026-10')).toBe('October 2026');
    expect(longBucket('weekly', '2026-W41')).toBe('Week 41 (5 Oct – 11 Oct 2026)');
  });
});

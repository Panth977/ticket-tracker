import { describe, expect, it } from 'vitest';
import {
  activeAggFields,
  addAgg,
  aggKeyFits,
  aggPeriodKey,
  aggPeriodKeys,
  aggSummary,
  boardAggFields,
  COST_AGG_FIELD,
  formatAgg,
  formatAggEntry,
  isoWeekOf,
  MessageAggSchema,
  roundAgg,
  type AggFieldDef,
} from './aggregates.js';

// 2026-10-05 00:30 IST is still 2026-10-04 in UTC: periods are cut in IST.
const EARLY_MON = Date.UTC(2026, 9, 4, 19, 0);

describe('aggregates', () => {
  it('period keys are cut in IST; weeks are ISO weeks', () => {
    expect(aggPeriodKey('daily', EARLY_MON)).toBe('2026-10-05');
    expect(aggPeriodKey('weekly', EARLY_MON)).toBe('2026-W41');
    expect(aggPeriodKey('monthly', EARLY_MON)).toBe('2026-10');
    expect(isoWeekOf(2026, 1, 1)).toBe('2026-W01');
    expect(isoWeekOf(2027, 1, 1)).toBe('2026-W53');
    expect(isoWeekOf(2025, 12, 29)).toBe('2026-W01');
  });

  it('aggPeriodKeys: the last n buckets, oldest first, across year ends', () => {
    expect(aggPeriodKeys('daily', EARLY_MON, 3)).toEqual([
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ]);
    expect(aggPeriodKeys('monthly', Date.UTC(2026, 1, 10), 3)).toEqual([
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(aggPeriodKeys('weekly', Date.UTC(2026, 0, 6), 3)).toEqual([
      '2025-W52',
      '2026-W01',
      '2026-W02',
    ]);
    expect(aggPeriodKeys('daily', EARLY_MON, 30)).toHaveLength(30);
    expect(new Set(aggPeriodKeys('weekly', EARLY_MON, 26)).size).toBe(26);
  });

  it('aggKeyFits tells the periods apart', () => {
    expect(aggKeyFits('daily', '2026-10-05')).toBe(true);
    expect(aggKeyFits('weekly', '2026-W41')).toBe(true);
    expect(aggKeyFits('monthly', '2026-10')).toBe(true);
    expect(aggKeyFits('weekly', '2026-10')).toBe(false);
    expect(aggKeyFits('monthly', '2026-10-05')).toBe(false);
  });

  it('addAgg counts and rounds away float drift', () => {
    let c = addAgg(undefined, 0.1);
    c = addAgg(c, 0.2);
    expect(c).toEqual({ total: 0.3, count: 2 });
    expect(addAgg(c, -0.5)).toEqual({ total: -0.2, count: 3 });
    expect(roundAgg(1.0000004)).toBe(1);
  });

  it('formats values, entries and a message summary', () => {
    expect(formatAgg(1.24, '$')).toBe('$1.24');
    expect(formatAgg(-3, '$')).toBe('-$3.00');
    expect(formatAgg(12.5, 'h')).toBe('12.5 h');
    expect(formatAgg(7, '')).toBe('7');
    const time: AggFieldDef = {
      id: 'a_time01',
      label: 'Time',
      unit: 'h',
      period: 'weekly',
      position: 1,
    };
    expect(formatAggEntry(1.24, COST_AGG_FIELD)).toBe('+$1.24 Cost');
    expect(formatAggEntry(-2, time)).toBe('−2 h Time');
    expect(
      aggSummary(
        [
          { fieldId: 'cost', value: 1.24 },
          { fieldId: 'a_time01', value: -2 },
          { fieldId: 'a_gone00', value: 1 },
        ],
        [COST_AGG_FIELD, time],
      ),
    ).toBe('+$1.24 Cost · −2 h Time');
  });

  it('a board from before aggregates behaves as if it had Cost', () => {
    expect(boardAggFields({})).toEqual([COST_AGG_FIELD]);
    const fields: AggFieldDef[] = [
      { id: 'a_b00000', label: 'B', unit: '', period: 'daily', position: 2 },
      { id: 'a_a00000', label: 'A', unit: '', period: 'daily', position: 1, archived: true },
    ];
    expect(boardAggFields({ aggFields: fields }).map((f) => f.id)).toEqual([
      'a_a00000',
      'a_b00000',
    ]);
    expect(activeAggFields({ aggFields: fields }).map((f) => f.id)).toEqual(['a_b00000']);
    expect(activeAggFields({ aggFields: [] })).toEqual([]);
  });

  it('MessageAggSchema: 1..10 entries, one per field, finite and bounded', () => {
    const ok = (entries: unknown) => MessageAggSchema.safeParse({ entries }).success;
    expect(ok([{ fieldId: 'cost', value: -1 }])).toBe(true);
    expect(ok([])).toBe(false);
    expect(
      ok([
        { fieldId: 'cost', value: 1 },
        { fieldId: 'cost', value: 2 },
      ]),
    ).toBe(false);
    expect(ok([{ fieldId: 'cost', value: Infinity }])).toBe(false);
    expect(ok([{ fieldId: 'cost', value: 2e12 }])).toBe(false);
    expect(ok([{ fieldId: 'nope', value: 1 }])).toBe(false);
  });
});

describe('agg.at: what an entry is FOR', () => {
  it('reads a bare date as noon of that day in the owner zone; ISO and millis as given', async () => {
    const { aggAtFrom, aggPeriodKey } = await import('./aggregates.js');
    const d = aggAtFrom('2026-10-04')!;
    expect(aggPeriodKey('daily', d)).toBe('2026-10-04');
    expect(aggAtFrom('2026-10-04T10:00:00Z')).toBe(Date.parse('2026-10-04T10:00:00Z'));
    expect(aggAtFrom(1234)).toBe(1234);
    expect(aggAtFrom('last tuesday')).toBeNull();
  });
  it('refuses the future and more than 400 days back', async () => {
    const { aggAtProblem } = await import('./aggregates.js');
    const now = Date.UTC(2026, 9, 6);
    expect(aggAtProblem(now - 86_400_000, now)).toBeNull();
    expect(aggAtProblem(now + 86_400_000, now)).toMatch(/future/);
    expect(aggAtProblem(now - 401 * 86_400_000, now)).toMatch(/400 days/);
  });
});

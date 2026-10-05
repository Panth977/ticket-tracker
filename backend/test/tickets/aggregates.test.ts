/** aggregates.html — the pure planners behind messagePost and boardUpdate. */
import { describe, expect, it } from 'vitest';
import { COST_AGG_FIELD, type AggFieldDef, type Board } from '@tm/shared';
import { planAggEntries } from '../../src/commands/messagePost.js';
import { planAggFields } from '../../src/commands/boardUpdate.js';

const TIME: AggFieldDef = {
  id: 'a_time01',
  label: 'Time',
  unit: 'h',
  period: 'weekly',
  position: 1,
};
const OLD: AggFieldDef = { ...TIME, id: 'a_old001', label: 'Old', archived: true };

describe('planAggEntries', () => {
  it('takes active fields, adds the receipt cost first, refuses unknown / archived / double cost', () => {
    expect(
      planAggEntries([COST_AGG_FIELD, TIME], { entries: [{ fieldId: TIME.id, value: 2 }] }, null),
    ).toEqual([{ fieldId: TIME.id, value: 2 }]);
    expect(
      planAggEntries([COST_AGG_FIELD, TIME], { entries: [{ fieldId: TIME.id, value: 2 }] }, 1.5),
    ).toEqual([
      { fieldId: 'cost', value: 1.5 },
      { fieldId: TIME.id, value: 2 },
    ]);
    // No active cost field: a receipt counts nowhere.
    expect(planAggEntries([TIME], undefined, 1.5)).toEqual([]);
    expect(planAggEntries([{ ...COST_AGG_FIELD, archived: true }], undefined, 1.5)).toEqual([]);
    expect(() =>
      planAggEntries([TIME], { entries: [{ fieldId: 'a_nope00', value: 1 }] }, null),
    ).toThrow(/No aggregate field/);
    expect(() =>
      planAggEntries([TIME, OLD], { entries: [{ fieldId: OLD.id, value: 1 }] }, null),
    ).toThrow(/removed/);
    expect(() =>
      planAggEntries([COST_AGG_FIELD], { entries: [{ fieldId: 'cost', value: 1 }] }, 2),
    ).toThrow(/receipt/);
  });
});

describe('planAggFields', () => {
  const board = (aggFields: AggFieldDef[] | undefined, aggs?: Board['aggs']) =>
    ({ aggFields, aggs }) as Board;
  it('archives the missing, refuses duplicates, locks a counted period', () => {
    expect(planAggFields(board([COST_AGG_FIELD, TIME]), [TIME])).toEqual([
      TIME,
      { ...COST_AGG_FIELD, archived: true },
    ]);
    expect(() => planAggFields(board([]), [TIME, TIME])).toThrow(/Duplicate/);
    const counted = board([TIME], { [TIME.id]: { total: 1, count: 1 } });
    expect(() => planAggFields(counted, [{ ...TIME, period: 'daily' }])).toThrow(
      /period stays weekly/,
    );
    expect(planAggFields(counted, [{ ...TIME, label: 'Hours' }])).toEqual([
      { ...TIME, label: 'Hours' },
    ]);
    expect(planAggFields(board([TIME]), [{ ...TIME, period: 'daily' }])[0]!.period).toBe('daily');
    // A board from before aggregates: nothing to archive.
    expect(planAggFields(board(undefined), [COST_AGG_FIELD])).toEqual([COST_AGG_FIELD]);
    expect(planAggFields(board(undefined), [TIME])).toEqual([
      TIME,
      { ...COST_AGG_FIELD, archived: true },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { addMonths, monthGrid } from './calendar';

describe('monthGrid', () => {
  it('starts on Monday and covers the month', () => {
    const g = monthGrid(2026, 9); // Sep 2026: 1st is a Tuesday
    expect(g).toHaveLength(42);
    expect(g[0]).toEqual({ year: 2026, month: 8, day: 31, inMonth: false });
    expect(g[1]).toEqual({ year: 2026, month: 9, day: 1, inMonth: true });
    expect(g.filter((d) => d.inMonth)).toHaveLength(30);
  });
  it('addMonths wraps years', () => {
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  });
});

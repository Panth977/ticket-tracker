import { describe, expect, it } from 'vitest';
import {
  addDays,
  axisSteps,
  fillDays,
  labelIndices,
  longDay,
  rangeDays,
  rankTickets,
  shortDay,
  sumRange,
  tiles,
  topOfDay,
  type DayRow,
} from './aggregate';

const row = (day: string, tickets: Record<string, [usd: number, runs: number]>): DayRow => {
  const t = Object.fromEntries(
    Object.entries(tickets).map(([k, [usd, runs]]) => [k, { usd, runs }]),
  );
  return {
    day,
    costUsd: Object.values(t).reduce((s, c) => s + c.usd, 0),
    runs: Object.values(t).reduce((s, c) => s + c.runs, 0),
    tickets: t,
  };
};

const rows: DayRow[] = [
  row('2026-08-30', { 'OCZ-1': [3, 1] }),
  row('2026-09-01', { 'OCZ-5': [100, 2], 'OCZ-2': [1.5, 1] }),
  row('2026-09-20', { 'OCZ-5': [200, 3] }),
  row('2026-09-25', { 'OCZ-5': [102.27, 4], 'OCZ-9': [4, 1] }),
  row('2026-09-26', { 'OCZ-9': [0.75, 1] }),
];

describe('day arithmetic', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-09-26', 1)).toBe('2026-09-27');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });
  it('lists the range ending today, ascending', () => {
    expect(rangeDays('2026-09-26', 3)).toEqual(['2026-09-24', '2026-09-25', '2026-09-26']);
    expect(rangeDays('2026-09-26', 30)[0]).toBe('2026-08-28');
    expect(rangeDays('2026-09-26', 90)[0]).toBe('2026-06-29');
  });
  it('fills a slot per day with null for empty days', () => {
    const slots = fillDays(rows, rangeDays('2026-09-26', 3));
    expect(slots.map((s) => s?.day ?? null)).toEqual([null, '2026-09-25', '2026-09-26']);
  });
});

describe('sumRange', () => {
  it('sums everything with no bounds', () => {
    const s = sumRange(rows);
    expect(s.usd).toBeCloseTo(411.52, 6);
    expect(s.runs).toBe(13);
    expect(s.tickets).toBe(4);
  });
  it('is inclusive on both ends', () => {
    const s = sumRange(rows, '2026-09-01', '2026-09-20');
    expect(s.usd).toBeCloseTo(301.5, 6);
    expect(s.runs).toBe(6);
    expect(s.tickets).toBe(2);
  });
  it('returns zeros for an empty range', () => {
    expect(sumRange(rows, '2026-09-02', '2026-09-19')).toEqual({ usd: 0, runs: 0, tickets: 0 });
  });
});

describe('rankTickets', () => {
  it('ranks by spend, then turns, then key', () => {
    expect(rankTickets(rows).map((t) => [t.key, t.usd, t.runs])).toEqual([
      ['OCZ-5', 402.27, 9],
      ['OCZ-9', 4.75, 2],
      ['OCZ-1', 3, 1],
      ['OCZ-2', 1.5, 1],
    ]);
  });
  it('respects the range', () => {
    expect(rankTickets(rows, '2026-09-25').map((t) => t.key)).toEqual(['OCZ-5', 'OCZ-9']);
  });
  it('names a day’s top tickets', () => {
    expect(topOfDay(rows[3]!, 1).map((t) => t.key)).toEqual(['OCZ-5']);
    expect(topOfDay(null)).toEqual([]);
  });
});

describe('tiles', () => {
  it('cuts today, the last 7 days and the month from the rows', () => {
    const t = tiles(rows, '2026-09-26');
    expect(t.today.usd).toBeCloseTo(0.75, 6);
    expect(t.today.runs).toBe(1);
    expect(t.last7.usd).toBeCloseTo(307.02, 6); // 20th + 25th + 26th (the 20th is the window's first day)
    expect(t.month.usd).toBeCloseTo(408.52, 6); // everything but Aug 30
    expect(t.month.tickets).toBe(3);
    expect(t.range.usd).toBeCloseTo(411.52, 6);
    expect(t.perTicket).toBeCloseTo(411.52 / 4, 6);
  });
  it('has no average without tickets', () => {
    expect(tiles([], '2026-09-26').perTicket).toBeNull();
  });
});

describe('axisSteps', () => {
  it('picks round steps that cover the maximum', () => {
    expect(axisSteps(402.27)).toEqual({ step: 100, max: 500, ticks: [0, 100, 200, 300, 400, 500] });
    expect(axisSteps(7.3)).toEqual({ step: 2, max: 8, ticks: [0, 2, 4, 6, 8] });
    expect(axisSteps(0.9)).toEqual({ step: 0.2, max: 1, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] });
    expect(axisSteps(1000)).toEqual({ step: 200, max: 1000, ticks: [0, 200, 400, 600, 800, 1000] });
    expect(axisSteps(0.03)).toEqual({
      step: 0.005,
      max: 0.03,
      ticks: [0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03],
    });
    expect(axisSteps(12, 4)).toEqual({ step: 5, max: 15, ticks: [0, 5, 10, 15] });
  });
  it('still draws an axis for nothing', () => {
    expect(axisSteps(0)).toEqual({ step: 1, max: 1, ticks: [0, 1] });
    expect(axisSteps(NaN)).toEqual({ step: 1, max: 1, ticks: [0, 1] });
  });
});

describe('labels', () => {
  it('anchors x labels on the last slot and never crowds', () => {
    expect(labelIndices(30, 6)).toEqual([4, 9, 14, 19, 24, 29]);
    expect(labelIndices(7, 10)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(labelIndices(90, 6)).toEqual([14, 29, 44, 59, 74, 89]);
    expect(labelIndices(0, 6)).toEqual([]);
  });
  it('writes a day without shifting it', () => {
    expect(shortDay('2026-10-03')).toBe('3 Oct');
    expect(longDay('2026-10-03')).toBe('Sat 3 Oct 2026');
  });
});

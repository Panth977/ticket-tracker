import { describe, expect, it } from 'vitest';
import { zonedTimeToMillis } from '@tm/shared/logic/time';
import { barOf, clearDatePatch, dateOf, dayDiff, setDatePatch, shiftBarPatch } from './dates';

const tz = 'America/New_York';
const at = (d: number, h = 0, m = 0) => zonedTimeToMillis(2026, 3, d, h, m, tz);
const board = {
  fields: [
    { id: 'f_d', name: 'Launch', type: 'date', position: 0 },
    { id: 'f_r', name: 'Window', type: 'dateRange', position: 1 },
    { id: 'f_t', name: 'Client', type: 'text', position: 2 },
  ],
} as never;
const t = (over: Record<string, unknown> = {}) =>
  ({ dueAt: null, dueAllDay: true, startAt: null, fields: {}, ...over }) as never;

describe('dates', () => {
  it('dayDiff counts wall-clock days across DST (Mar 8 2026 in New York)', () => {
    expect(dayDiff(at(7, 12), at(9, 1), tz)).toBe(2);
    expect(dayDiff(at(9), at(7), tz)).toBe(-2);
  });

  it('dateOf reads built-ins and custom date / dateRange fields', () => {
    const x = t({ dueAt: at(5), fields: { f_d: at(6), f_r: { start: at(7), end: at(9) } } });
    expect(dateOf(x, 'due', board)).toBe(at(5));
    expect(dateOf(x, 'fields.f_d', board)).toBe(at(6));
    expect(dateOf(x, 'fields.f_r', board)).toBe(at(7));
    expect(dateOf(x, 'fields.f_r', board, true)).toBe(at(9));
    expect(dateOf(x, 'fields.f_t', board)).toBeNull();
  });

  it('moving a timed due date keeps its time of day', () => {
    expect(
      setDatePatch(t({ dueAt: at(5, 15, 30), dueAllDay: false }), 'due', board, at(10, 9), tz),
    ).toEqual({ dueAt: at(10, 15, 30) });
  });

  it('scheduling an undated ticket makes it all-day at 00:00', () => {
    expect(setDatePatch(t(), 'due', board, at(10, 18), tz)).toEqual({
      dueAt: at(10),
      dueAllDay: true,
    });
    expect(setDatePatch(t(), 'fields.f_d', board, at(10, 18), tz)).toEqual({
      fields: { f_d: at(10) },
    });
  });

  it('a dateRange shifts both ends', () => {
    const x = t({ fields: { f_r: { start: at(2), end: at(4) } } });
    expect(setDatePatch(x, 'fields.f_r', board, at(12), tz)).toEqual({
      fields: { f_r: { start: at(12), end: at(14) } },
    });
  });

  it('clearDatePatch clears only that field', () => {
    expect(clearDatePatch('due', board)).toEqual({ dueAt: null, dueAllDay: true });
    expect(clearDatePatch('fields.f_d', board)).toEqual({ fields: { f_d: null } });
    expect(clearDatePatch('fields.f_t', board)).toBeNull();
  });

  it('barOf spans start→due, or one day when only one is set', () => {
    expect(barOf(t({ startAt: at(2), dueAt: at(5, 17) }), 'start', 'due', board, tz)).toEqual({
      start: at(2),
      end: at(5),
    });
    expect(barOf(t({ dueAt: at(5) }), 'start', 'due', board, tz)).toEqual({
      start: at(5),
      end: at(5),
    });
    expect(barOf(t(), 'start', 'due', board, tz)).toBeNull();
  });

  it('shiftBarPatch drags ends and whole bars', () => {
    const x = t({ startAt: at(2), dueAt: at(5), dueAllDay: true });
    expect(shiftBarPatch(x, 'start', 'due', board, tz, 'both', 3)).toEqual({
      startAt: at(5),
      dueAt: at(8),
    });
    expect(shiftBarPatch(x, 'start', 'due', board, tz, 'end', 2)).toEqual({ dueAt: at(7) });
    expect(shiftBarPatch(x, 'start', 'due', board, tz, 'start', -1)).toEqual({ startAt: at(1) });
    // Dragging the start past the end collapses to a one-day bar on the end day.
    expect(shiftBarPatch(x, 'start', 'due', board, tz, 'start', 10)).toEqual({ startAt: at(5) });
    expect(shiftBarPatch(x, 'start', 'due', board, tz, 'both', 0)).toBeNull();
  });

  it('a one-sided bar gets its missing end filled when stretched', () => {
    const x = t({ dueAt: at(5) });
    expect(shiftBarPatch(x, 'start', 'due', board, tz, 'start', -2)).toEqual({ startAt: at(3) });
    expect(shiftBarPatch(x, 'start', 'due', board, tz, 'end', 2)).toEqual({
      startAt: at(5),
      dueAt: at(7),
    });
  });
});

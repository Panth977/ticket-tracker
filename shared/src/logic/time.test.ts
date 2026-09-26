import { describe, expect, it } from 'vitest';
import {
  DAY,
  HOUR,
  MINUTE,
  addDaysTz,
  dayRange,
  dueSoon,
  effectiveDue,
  inQuietHours,
  isOverdue,
  nextAfterQuietHours,
  parseDue,
  weekRange,
  zonedParts,
} from './time.js';
import {
  findTicketKeys,
  isBoardKey,
  isTicketKey,
  normalizeBoardKey,
  parseTicketKey,
  suggestBoardKey,
} from './validators.js';

// Tuesday 2026-09-22 09:00 UTC = 14:30 in Kolkata (+05:30), 05:00 in New York (-04:00).
const T0 = Date.UTC(2026, 8, 22, 9, 0, 0);
const IST = 'Asia/Kolkata';
const NY = 'America/New_York';

describe('zoned calendar', () => {
  it('parts', () => {
    expect(zonedParts(T0, IST)).toMatchObject({
      year: 2026,
      month: 9,
      day: 22,
      hour: 14,
      minute: 30,
      weekday: 2,
    });
    expect(zonedParts(T0, NY)).toMatchObject({ hour: 5, weekday: 2 });
  });
  it('dayRange is local midnight to midnight', () => {
    const r = dayRange(T0, IST);
    expect(r.start).toBe(Date.UTC(2026, 8, 21, 18, 30));
    expect(r.end - r.start).toBe(DAY);
  });
  it('weekRange starts Monday', () => {
    const r = weekRange(T0, IST);
    expect(r.start).toBe(Date.UTC(2026, 8, 20, 18, 30)); // Mon 21 00:00 IST
    expect(r.end - r.start).toBe(7 * DAY);
    const sun = weekRange(T0, IST, 0);
    expect(zonedParts(sun.start, IST).weekday).toBe(0);
  });
  it('a DST day is 23 hours long', () => {
    const march8 = Date.UTC(2026, 2, 8, 17, 0); // US spring-forward day
    const r = dayRange(march8, NY);
    expect(r.end - r.start).toBe(23 * HOUR);
    expect(addDaysTz(Date.UTC(2026, 2, 7, 17, 0), 1, NY)).toBe(Date.UTC(2026, 2, 8, 16, 0));
  });
});

describe('deadlines', () => {
  it('dueSoon within lead time only', () => {
    expect(dueSoon(T0 + 60 * MINUTE, 1440, T0)).toBe(true);
    expect(dueSoon(T0 + 1440 * MINUTE, 1440, T0)).toBe(true);
    expect(dueSoon(T0 + 1441 * MINUTE, 1440, T0)).toBe(false);
    expect(dueSoon(T0 - 1, 1440, T0)).toBe(false); // already overdue
    expect(dueSoon(T0 + MINUTE, 0, T0)).toBe(false);
    expect(dueSoon(null, 1440, T0)).toBe(false);
  });
  it('overdue; all-day due lasts the whole local day', () => {
    expect(isOverdue(T0 - 1, T0)).toBe(true);
    expect(isOverdue(T0 + 1, T0)).toBe(false);
    expect(isOverdue(null, T0)).toBe(false);
    const todayIst = dayRange(T0, IST).start;
    expect(isOverdue(todayIst, T0, { allDay: true, tz: IST })).toBe(false);
    expect(effectiveDue(todayIst, true, IST)).toBe(todayIst + DAY);
    expect(isOverdue(todayIst, todayIst + DAY, { allDay: true, tz: IST })).toBe(true);
  });
});

describe('quiet hours', () => {
  const user = (quietHours: { start: string; end: string } | null, timezone = IST) => ({
    timezone,
    notify: { quietHours },
  });
  const istAt = (h: number, m = 0, dayOffset = 0) =>
    Date.UTC(2026, 8, 22 + dayOffset, h, m) - 330 * MINUTE;

  it('null or empty window → never quiet', () => {
    expect(inQuietHours(user(null), T0)).toBe(false);
    expect(inQuietHours(user({ start: '09:00', end: '09:00' }), T0)).toBe(false);
  });
  it('overnight window wraps midnight', () => {
    const u = user({ start: '22:00', end: '08:00' });
    expect(inQuietHours(u, istAt(23))).toBe(true);
    expect(inQuietHours(u, istAt(2))).toBe(true);
    expect(inQuietHours(u, istAt(8))).toBe(false); // end exclusive
    expect(inQuietHours(u, istAt(22))).toBe(true); // start inclusive
    expect(inQuietHours(u, istAt(14, 30))).toBe(false);
  });
  it('daytime window', () => {
    const u = user({ start: '13:00', end: '15:00' });
    expect(inQuietHours(u, T0)).toBe(true); // 14:30 IST
    expect(inQuietHours(u, istAt(15))).toBe(false);
  });
  it('nextAfterQuietHours', () => {
    const u = user({ start: '22:00', end: '08:00' });
    expect(nextAfterQuietHours(u, T0)).toBe(T0);
    expect(nextAfterQuietHours(u, istAt(23))).toBe(istAt(8, 0, 1)); // tomorrow 08:00
    expect(nextAfterQuietHours(u, istAt(3))).toBe(istAt(8)); // today 08:00
  });
  it("follows the person's zone", () => {
    const u = user({ start: '22:00', end: '08:00' }, NY);
    expect(inQuietHours(u, T0)).toBe(true); // 05:00 in NY
    expect(nextAfterQuietHours(u, T0)).toBe(Date.UTC(2026, 8, 22, 12, 0));
  });
});

describe('parseDue (Tue 2026-09-22 14:30 IST)', () => {
  const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - 330 * MINUTE;
  it.each([
    ['today', day(2026, 9, 22)],
    ['tomorrow', day(2026, 9, 23)],
    ['tmr', day(2026, 9, 23)],
    ['fri', day(2026, 9, 25)],
    ['Friday', day(2026, 9, 25)],
    ['mon', day(2026, 9, 28)],
    ['tue', day(2026, 9, 29)], // today's weekday → a week out
    ['next week', day(2026, 9, 28)],
    ['+3d', day(2026, 9, 25)],
    ['2w', day(2026, 10, 6)],
    ['2026-10-01', day(2026, 10, 1)],
    ['1/10', day(2026, 10, 1)],
    ['oct 1', day(2026, 10, 1)],
    ['1 oct', day(2026, 10, 1)],
    ['sep 1', day(2027, 9, 1)], // already passed this year
  ])('%s', (input, at) => {
    expect(parseDue(input, T0, IST)).toEqual({ at, allDay: true });
  });
  it('with a time', () => {
    expect(parseDue('fri@17:00', T0, IST)).toEqual({
      at: day(2026, 9, 25) + 17 * HOUR,
      allDay: false,
    });
    expect(parseDue('tomorrow 9:30', T0, IST)).toEqual({
      at: day(2026, 9, 23) + 9.5 * HOUR,
      allDay: false,
    });
  });
  it.each(['', 'someday', '2026-02-31', '32/1', 'foo 3', '25:00'])('rejects %j', (s) => {
    expect(parseDue(s, T0, IST)).toBeNull();
  });
});

describe('key validators', () => {
  it('board keys', () => {
    expect(isBoardKey('ENG')).toBe(true);
    expect(isBoardKey('E')).toBe(false);
    expect(isBoardKey('1AB')).toBe(false);
    expect(isBoardKey('ABCDEFG')).toBe(false);
    expect(normalizeBoardKey(' eng-1 ')).toBe('ENG1');
    expect(suggestBoardKey('Engineering')).toBe('ENG');
    expect(suggestBoardKey('Growth Marketing')).toBe('GM');
    expect(suggestBoardKey('!!')).toBe('BRD');
  });
  it('ticket keys', () => {
    expect(isTicketKey('ENG-42')).toBe(true);
    expect(isTicketKey('ENG-0')).toBe(false);
    expect(isTicketKey('eng-42')).toBe(false);
    expect(parseTicketKey('#eng-42')).toEqual({ boardKey: 'ENG', number: 42, key: 'ENG-42' });
    expect(parseTicketKey('ENG42')).toBeNull();
    expect(findTicketKeys('see #ENG-40 and #ops-7, not a#ENG-1, again #ENG-40')).toEqual([
      'ENG-40',
      'OPS-7',
    ]);
  });
});

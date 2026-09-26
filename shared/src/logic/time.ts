/**
 * Time helpers — every calendar question is asked IN A TIME ZONE.
 *
 * Millis are UTC instants; 'today', 'this week', 'friday' and quiet hours are
 * wall-clock ideas that only mean something in the person's IANA zone
 * (users/{uid}.timezone). Everything here takes `now` explicitly — commands
 * never call Date.now() themselves (tests pin it).
 */
import { fromZonedTime } from 'date-fns-tz';
import type { Millis } from '../types/index.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface ZonedParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock parts of an instant in a zone. Throws RangeError on an unknown zone. */
export function zonedParts(ms: Millis, tz: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ''),
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** The instant at a wall-clock time in a zone (DST gaps resolve forward, as date-fns-tz does). */
export function zonedTimeToMillis(
  y: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Millis {
  // Normalise overflow (day 32, month 13) through a UTC date first.
  const d = new Date(Date.UTC(y, month - 1, day, hour, minute));
  const iso = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
  return fromZonedTime(iso, tz).getTime();
}

export interface Range {
  /** inclusive */
  start: Millis;
  /** exclusive */
  end: Millis;
}

export function startOfDayTz(ms: Millis, tz: string): Millis {
  const p = zonedParts(ms, tz);
  return zonedTimeToMillis(p.year, p.month, p.day, 0, 0, tz);
}

/** Same wall-clock time `n` days later (DST-safe: days are not 24h everywhere). */
export function addDaysTz(ms: Millis, n: number, tz: string): Millis {
  const p = zonedParts(ms, tz);
  return (
    zonedTimeToMillis(p.year, p.month, p.day + n, p.hour, p.minute, tz) +
    p.second * 1000 +
    (ms % 1000)
  );
}

export function dayRange(ms: Millis, tz: string): Range {
  const p = zonedParts(ms, tz);
  return {
    start: zonedTimeToMillis(p.year, p.month, p.day, 0, 0, tz),
    end: zonedTimeToMillis(p.year, p.month, p.day + 1, 0, 0, tz),
  };
}

/** The week containing `ms`; weeks start on Monday unless told otherwise. */
export function weekRange(ms: Millis, tz: string, weekStartsOn = 1): Range {
  const p = zonedParts(ms, tz);
  const back = (p.weekday - weekStartsOn + 7) % 7;
  return {
    start: zonedTimeToMillis(p.year, p.month, p.day - back, 0, 0, tz),
    end: zonedTimeToMillis(p.year, p.month, p.day - back + 7, 0, 0, tz),
  };
}

export function sameDayTz(a: Millis, b: Millis, tz: string): boolean {
  const r = dayRange(a, tz);
  return b >= r.start && b < r.end;
}

// ───────────────────────── deadlines ─────────────────────────

/**
 * The instant a due date actually passes. An all-day due date is due for the
 * WHOLE day in the viewer's zone, so it is overdue only once that day ends.
 */
export function effectiveDue(dueAt: Millis, allDay: boolean, tz: string): Millis {
  return allDay ? dayRange(dueAt, tz).end : dueAt;
}

export function isOverdue(
  dueAt: Millis | null,
  now: Millis,
  opts: { allDay?: boolean; tz?: string } = {},
): boolean {
  if (dueAt == null) return false;
  const at = opts.allDay && opts.tz ? effectiveDue(dueAt, true, opts.tz) : dueAt;
  return at <= now;
}

/**
 * deadlineSweep's question, per person: is this due within their lead time
 * and not yet passed? leadMinutes = user.notify.dueSoonLeadMinutes.
 */
export function dueSoon(dueAt: Millis | null, leadMinutes: number, now: Millis): boolean {
  if (dueAt == null || leadMinutes <= 0) return false;
  return dueAt > now && dueAt - now <= leadMinutes * MINUTE;
}

// ───────────────────────── quiet hours ─────────────────────────

export interface QuietHoursUser {
  timezone: string;
  notify: { quietHours: { start: string; end: string } | null };
}

const toMinutes = (hhmm: string): number => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new RangeError(`Bad HH:MM '${hhmm}'`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/**
 * In the person's quiet window? start > end wraps midnight ('22:00'–'08:00').
 * start == end is an empty window (never quiet). Start inclusive, end exclusive.
 */
export function inQuietHours(user: QuietHoursUser, now: Millis): boolean {
  const q = user.notify.quietHours;
  if (!q) return false;
  const s = toMinutes(q.start);
  const e = toMinutes(q.end);
  if (s === e) return false;
  const p = zonedParts(now, user.timezone);
  const cur = p.hour * 60 + p.minute;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/**
 * When a delivery held for quiet hours may go out: `now` if not quiet, else
 * the next time the window ends, in the person's zone.
 */
export function nextAfterQuietHours(user: QuietHoursUser, now: Millis): Millis {
  if (!inQuietHours(user, now)) return now;
  const q = user.notify.quietHours!;
  const e = toMinutes(q.end);
  const p = zonedParts(now, user.timezone);
  const cur = p.hour * 60 + p.minute;
  const dayOffset = cur < e ? 0 : 1;
  return zonedTimeToMillis(
    p.year,
    p.month,
    p.day + dayOffset,
    Math.floor(e / 60),
    e % 60,
    user.timezone,
  );
}

// ───────────────────────── natural due dates ─────────────────────────

const DOW: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface ParsedDue {
  /** Start of the chosen day (all-day) or the exact instant. */
  at: Millis;
  allDay: boolean;
}

/**
 * Parse what a person types after 'due:' — relative to `now` in `tz`.
 *   today, tod, tomorrow, tmr, yesterday
 *   mon … sun         the NEXT such day (today's weekday → a week out)
 *   next week         Monday of next week (weekStartsOn)
 *   +3d, +2w, 3d      offsets
 *   2026-09-30, 30/9 (day first), sep 30, 30 sep
 *   any of the above followed by @17:00 or 17:00 → a timed due (not all-day)
 * Returns null when it is not a date.
 */
export function parseDue(
  input: string,
  now: Millis,
  tz: string,
  weekStartsOn = 1,
): ParsedDue | null {
  let s = input.trim().toLowerCase().replace(/_/g, ' ');
  if (!s) return null;
  let time: { h: number; m: number } | null = null;
  const tm = /(?:^|\s|@)(\d{1,2}):(\d{2})$/.exec(s);
  if (tm) {
    const h = Number(tm[1]);
    const m = Number(tm[2]);
    if (h > 23 || m > 59) return null;
    time = { h, m };
    s = s.slice(0, tm.index).replace(/@$/, '').trim();
  }
  const p = zonedParts(now, tz);
  let ymd: { y: number; mo: number; d: number } | null = null;
  /** Typed as a calendar date (not relative) — must be a real date. */
  let explicit = false;
  const at = (days: number) => ({ y: p.year, mo: p.month, d: p.day + days });

  let m: RegExpExecArray | null;
  if (s === '' && time) ymd = at(0);
  else if (s === 'today' || s === 'tod') ymd = at(0);
  else if (s === 'tomorrow' || s === 'tmr' || s === 'tmrw') ymd = at(1);
  else if (s === 'yesterday') ymd = at(-1);
  else if (s === 'next week' || s === 'nextweek') {
    const back = (p.weekday - weekStartsOn + 7) % 7;
    ymd = at(7 - back);
  } else if (s in DOW) {
    const diff = (DOW[s]! - p.weekday + 7) % 7 || 7;
    ymd = at(diff);
  } else if ((m = /^\+?(\d{1,3})\s*([dw])$/.exec(s))) {
    ymd = at(Number(m[1]) * (m[2] === 'w' ? 7 : 1));
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) {
    ymd = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
    explicit = true;
  } else if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : p.year;
    ymd = { y, mo: Number(m[2]), d: Number(m[1]) };
    explicit = true;
  } else if (
    (m = /^([a-z]{3})[a-z]*\s+(\d{1,2})$/.exec(s)) ||
    (m = /^(\d{1,2})\s+([a-z]{3})[a-z]*$/.exec(s))
  ) {
    const [mon, day] = /^\d/.test(m[1]!) ? [m[2]!, m[1]!] : [m[1]!, m[2]!];
    const mo = MONTHS.indexOf(mon) + 1;
    if (mo === 0) return null;
    // 'sep 3' in October means next September.
    const y = mo < p.month || (mo === p.month && Number(day) < p.day) ? p.year + 1 : p.year;
    ymd = { y, mo, d: Number(day) };
    explicit = true;
  }
  if (!ymd) return null;
  if (explicit) {
    // Reject impossible dates like 2026-02-31 instead of rolling them over.
    const probe = new Date(Date.UTC(ymd.y, ymd.mo - 1, ymd.d));
    if (ymd.d < 1 || probe.getUTCMonth() !== ymd.mo - 1) return null;
  }
  return {
    at: zonedTimeToMillis(ymd.y, ymd.mo, ymd.d, time?.h ?? 0, time?.m ?? 0, tz),
    allDay: !time,
  };
}

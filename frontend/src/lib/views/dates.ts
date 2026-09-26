/**
 * Date maths for the Calendar and Timeline views.
 *
 * A view's `dateField` ('due' | 'start' | `fields.${id}`) anchors a ticket on a
 * day; the timeline adds `endDateField` for the bar's end. Moving a ticket by
 * drag is always "shift by N whole days in the viewer's zone" — the wall-clock
 * time of a timed due date survives, an all-day date stays at 00:00 — and it is
 * ONE ticketUpdate touching only that field (dateRange custom fields shift both
 * ends so the span keeps its length).
 */
import type { Board, FieldValue, Millis, TicketPatch, TicketWithId } from '@tm/shared';
import {
  addDaysTz,
  dayRange,
  startOfDayTz,
  zonedParts,
  zonedTimeToMillis,
} from '@tm/shared/logic/time';

type DateTicket = Pick<TicketWithId, 'dueAt' | 'dueAllDay' | 'startAt' | 'fields'>;
type BoardShape = Pick<Board, 'fields'>;

/** The custom field behind a `fields.${id}` key, when it is a date / dateRange. */
function dateDef(board: BoardShape, key: string) {
  if (!key.startsWith('fields.')) return undefined;
  const id = key.slice(7);
  return board.fields.find((f) => f.id === id && (f.type === 'date' || f.type === 'dateRange'));
}

const isRange = (v: FieldValue | undefined): v is { start: Millis; end: Millis } =>
  v != null && typeof v === 'object' && !Array.isArray(v) && 'start' in v;

/** Where the ticket sits for `key`; for a dateRange field, `end` picks the range's end. */
export function dateOf(
  t: DateTicket,
  key: string | null | undefined,
  board: BoardShape,
  end = false,
): Millis | null {
  switch (key) {
    case 'due':
      return t.dueAt ?? null;
    case 'start':
      return t.startAt ?? null;
  }
  if (!key) return null;
  const def = dateDef(board, key);
  if (!def) return null;
  const v = t.fields[def.id];
  if (isRange(v)) return end ? v.end : v.start;
  return typeof v === 'number' ? v : null;
}

/** Whole days from `a`'s day to `b`'s day in `tz` (negative when b is earlier). */
export function dayDiff(a: Millis, b: Millis, tz: string): number {
  const pa = zonedParts(a, tz);
  const pb = zonedParts(b, tz);
  return Math.round(
    (Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) /
      86_400_000,
  );
}

/** 00:00 of the day `ms` falls on, `n` days later (DST-safe). */
export function dayStart(ms: Millis, tz: string, n = 0): Millis {
  const p = zonedParts(ms, tz);
  return zonedTimeToMillis(p.year, p.month, p.day + n, 0, 0, tz);
}

/**
 * The patch that puts `t`'s `key` date on `day` (any instant within the target
 * day). Unscheduled tickets land at 00:00 (all-day). null = not a writable date.
 */
export function setDatePatch(
  t: DateTicket,
  key: string | null | undefined,
  board: BoardShape,
  day: Millis,
  tz: string,
): TicketPatch | null {
  const cur = dateOf(t, key, board);
  const target = startOfDayTz(day, tz);
  const shifted = cur == null ? target : addDaysTz(cur, dayDiff(cur, target, tz), tz);
  switch (key) {
    case 'due':
      return cur == null ? { dueAt: target, dueAllDay: true } : { dueAt: shifted };
    case 'start':
      return { startAt: shifted };
  }
  if (!key) return null;
  const def = dateDef(board, key);
  if (!def) return null;
  const v = t.fields[def.id];
  if (def.type === 'dateRange') {
    if (isRange(v)) {
      const d = dayDiff(v.start, target, tz);
      return {
        fields: { [def.id]: { start: addDaysTz(v.start, d, tz), end: addDaysTz(v.end, d, tz) } },
      };
    }
    return { fields: { [def.id]: { start: target, end: target } } };
  }
  return { fields: { [def.id]: shifted } };
}

/** Clear the `key` date (a chip dropped on the unscheduled tray). */
export function clearDatePatch(
  key: string | null | undefined,
  board: BoardShape,
): TicketPatch | null {
  switch (key) {
    case 'due':
      return { dueAt: null, dueAllDay: true };
    case 'start':
      return { startAt: null };
  }
  if (!key) return null;
  const def = dateDef(board, key);
  return def ? { fields: { [def.id]: null } } : null;
}

/** A timeline bar: the start and end DAYS (inclusive) a ticket covers, or null when it has no date at all. */
export function barOf(
  t: DateTicket,
  startKey: string | null | undefined,
  endKey: string | null | undefined,
  board: BoardShape,
  tz: string,
): { start: Millis; end: Millis } | null {
  // A dateRange field as the start key carries its own end.
  const sameRange =
    startKey != null &&
    dateDef(board, startKey)?.type === 'dateRange' &&
    (!endKey || endKey === startKey);
  let s = dateOf(t, startKey, board);
  let e = sameRange ? dateOf(t, startKey, board, true) : dateOf(t, endKey, board);
  if (s == null && e == null) return null;
  s ??= e!;
  e ??= s;
  const a = startOfDayTz(Math.min(s, e), tz);
  const b = startOfDayTz(Math.max(s, e), tz);
  return { start: a, end: b };
}

/**
 * The patch for dragging a timeline bar: `edge` 'start' / 'end' moves one end,
 * 'both' shifts the whole bar, by `days`. Ends that were empty are filled from
 * the bar so the result is a real span.
 */
export function shiftBarPatch(
  t: DateTicket,
  startKey: string | null | undefined,
  endKey: string | null | undefined,
  board: BoardShape,
  tz: string,
  edge: 'start' | 'end' | 'both',
  days: number,
): TicketPatch | null {
  const bar = barOf(t, startKey, endKey, board, tz);
  if (!bar || days === 0) return null;
  let s = bar.start;
  let e = bar.end;
  if (edge !== 'end') s = addDaysTz(s, days, tz);
  if (edge !== 'start') e = addDaysTz(e, days, tz);
  if (s > e) [s, e] = edge === 'start' ? [e, e] : [s, s];

  const sameRange =
    startKey != null &&
    dateDef(board, startKey)?.type === 'dateRange' &&
    (!endKey || endKey === startKey);
  if (sameRange) {
    const def = dateDef(board, startKey)!;
    return { fields: { [def.id]: { start: s, end: e } } };
  }
  const out: TicketPatch = {};
  const put = (key: string | null | undefined, day: Millis) => {
    const p = setDatePatch(t, key, board, day, tz);
    if (!p) return;
    Object.assign(out, {
      ...p,
      fields: p.fields || out.fields ? { ...out.fields, ...p.fields } : undefined,
    });
    if (!out.fields) delete out.fields;
  };
  if (edge !== 'end' || dateOf(t, startKey, board) == null) put(startKey, s);
  if (edge !== 'start' || dateOf(t, endKey, board) == null) put(endKey, e);
  return Object.keys(out).length ? out : null;
}

/** Is `ms` inside the day that starts at `day`? */
export function onDay(ms: Millis, day: Millis, tz: string): boolean {
  const r = dayRange(day, tz);
  return ms >= r.start && ms < r.end;
}

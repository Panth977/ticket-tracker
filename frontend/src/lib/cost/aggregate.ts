/**
 * THE SUMS BEHIND THE ANALYTICS VIEW (docs/plan/agents.html §Y3) — pure
 * functions over the board's day rows (boards/{b}/stats/{yyyy-mm-dd}), so the
 * tiles, the chart and the ranked table can be tested without Firestore.
 *
 * Days are 'yyyy-mm-dd' strings cut in COST_DAY_TZ (schema/board.ts). They
 * sort as strings, and the arithmetic here is done in UTC on the string, so
 * the viewer's own time zone never shifts a bar.
 */
import type { BoardDayStats, CostCounter } from '@tm/shared';

export type DayRow = Pick<BoardDayStats, 'day' | 'costUsd' | 'runs' | 'tickets'>;

const DAY_MS = 86_400_000;

/** 'yyyy-mm-dd' → the UTC midnight of that day. */
export function dayToMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
}

/** UTC millis → 'yyyy-mm-dd'. */
export function msToDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The day `n` days after (or before, negative) `day`. */
export function addDays(day: string, n: number): string {
  return msToDay(dayToMs(day) + n * DAY_MS);
}

/** The `n` days ending on `today`, ascending — the chart's slots. */
export function rangeDays(today: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}

/** One slot per day, null where no receipt landed (an empty slot, not a zero). */
export function fillDays<R extends DayRow>(
  rows: readonly R[],
  days: readonly string[],
): (R | null)[] {
  const by = new Map(rows.map((r) => [r.day, r]));
  return days.map((d) => by.get(d) ?? null);
}

export interface RangeSum {
  usd: number;
  runs: number;
  /** Distinct tickets that had at least one receipt in the range. */
  tickets: number;
}

/** Sum of the rows with from <= day <= to (inclusive; either bound optional). */
export function sumRange(rows: readonly DayRow[], from?: string, to?: string): RangeSum {
  let usd = 0;
  let runs = 0;
  const keys = new Set<string>();
  for (const r of rows) {
    if (from && r.day < from) continue;
    if (to && r.day > to) continue;
    usd += r.costUsd;
    runs += r.runs;
    for (const [k, c] of Object.entries(r.tickets ?? {})) if (c.runs > 0 || c.usd > 0) keys.add(k);
  }
  return { usd, runs, tickets: keys.size };
}

export interface TicketSpend extends CostCounter {
  key: string;
}

/** Tickets of the range, most expensive first; ties by turns, then key. */
export function rankTickets(rows: readonly DayRow[], from?: string, to?: string): TicketSpend[] {
  const acc = new Map<string, TicketSpend>();
  for (const r of rows) {
    if (from && r.day < from) continue;
    if (to && r.day > to) continue;
    for (const [key, c] of Object.entries(r.tickets ?? {})) {
      const cur = acc.get(key) ?? { key, usd: 0, runs: 0 };
      cur.usd += c.usd;
      cur.runs += c.runs;
      acc.set(key, cur);
    }
  }
  return [...acc.values()]
    .filter((t) => t.usd > 0 || t.runs > 0)
    .sort((a, b) => b.usd - a.usd || b.runs - a.runs || a.key.localeCompare(b.key));
}

/** The day's own top tickets (the tooltip), most expensive first. */
export function topOfDay(row: DayRow | null, n = 3): TicketSpend[] {
  if (!row) return [];
  return rankTickets([row]).slice(0, n);
}

export interface Tiles {
  today: RangeSum;
  /** The 7 days ending today. */
  last7: RangeSum;
  /** The calendar month `today` is in. */
  month: RangeSum;
  /** Everything loaded (the range the page asked for). */
  range: RangeSum;
  /** range.usd / range.tickets — null when no ticket had a receipt. */
  perTicket: number | null;
}

/** The stat tiles, all from the day rows (the lifetime total comes off the board). */
export function tiles(rows: readonly DayRow[], today: string): Tiles {
  const range = sumRange(rows);
  return {
    today: sumRange(rows, today, today),
    last7: sumRange(rows, addDays(today, -6), today),
    month: sumRange(rows, today.slice(0, 7) + '-01', today),
    range,
    perTicket: range.tickets ? range.usd / range.tickets : null,
  };
}

export interface Axis {
  /** The distance between ticks — a round number (1 · 2 · 2.5 · 5 × 10ⁿ). */
  step: number;
  /** The top of the axis: the first tick at or above the maximum. */
  max: number;
  /** 0, step, 2·step … max. */
  ticks: number[];
}

/**
 * Round y-axis steps for a maximum: the smallest round step (1 · 2 · 2.5 · 5
 * × 10ⁿ) that covers the maximum in at most `maxIntervals` ticks. A chart
 * with nothing on it still has an axis (0 … 1) so the frame does not collapse.
 */
export function axisSteps(maxValue: number, maxIntervals = 6): Axis {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return { step: 1, max: 1, ticks: [0, 1] };
  let step = 1;
  outer: for (let e = Math.floor(Math.log10(maxValue)) - 2; e < 12; e++) {
    for (const k of [1, 2, 2.5, 5]) {
      const s = k * 10 ** e;
      if (Math.ceil(maxValue / s - 1e-9) <= maxIntervals) {
        step = s;
        break outer;
      }
    }
  }
  const max = Math.ceil(maxValue / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(round(v));
  return { step: round(step), max: round(max), ticks };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Which slots get an x label: every k-th, anchored on the LAST day so 'today'
 * is always named and the labels never crowd past `maxLabels`.
 */
export function labelIndices(n: number, maxLabels: number): number[] {
  if (n <= 0 || maxLabels <= 0) return [];
  const k = Math.max(1, Math.ceil(n / maxLabels));
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i -= k) out.unshift(i);
  return out;
}

/** '3 Oct' — a day id as a short label (UTC, so the id is not shifted). */
export function shortDay(day: string): string {
  return new Date(dayToMs(day)).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  });
}

/** 'Sat 3 Oct 2026' — a day id in full (the tooltip, the table). */
export function longDay(day: string): string {
  const d = new Date(dayToMs(day));
  const weekday = d.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short' });
  return `${weekday} ${shortDay(day)} ${d.getUTCFullYear()}`;
}

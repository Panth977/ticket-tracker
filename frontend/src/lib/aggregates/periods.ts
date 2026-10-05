/**
 * PERIOD BUCKETS (docs/plan/aggregates.html) — pure functions over the
 * board's aggStats docs (boards/{b}/aggStats/{period}:{key}), so the tiles,
 * the chart and the ranked table can be tested without Firestore.
 *
 * Keys are cut in AGG_TZ by the server (aggPeriodKey): 'yyyy-mm-dd' daily,
 * 'yyyy-Www' (ISO weeks) weekly, 'yyyy-mm' monthly. They sort as strings
 * within a period, and the arithmetic here is done in UTC on the key, so the
 * viewer's own time zone never shifts a bar.
 */
import {
  aggPeriodKeys,
  isoWeekOf,
  type AggCounter,
  type AggPeriod,
  type AggStats,
} from '@tm/shared';
import { addDays, dayToMs, longDay, msToDay, shortDay } from '$lib/cost/aggregate';

/** One field's slice of one bucket doc. */
export interface AggBucket {
  key: string;
  total: number;
  count: number;
  tickets: Record<string, AggCounter>;
}

/** The range choices per period, and the default (the first). */
export const PERIOD_RANGES: Record<AggPeriod, readonly number[]> = {
  daily: [30, 90],
  weekly: [12, 26],
  monthly: [6, 12],
};
export const PERIOD_UNIT: Record<AggPeriod, [string, string]> = {
  daily: ['day', 'days'],
  weekly: ['week', 'weeks'],
  monthly: ['month', 'months'],
};
export const periodWord = (p: AggPeriod, n: number) => `${n} ${PERIOD_UNIT[p][n === 1 ? 0 : 1]}`;
export const PERIOD_LABEL: Record<AggPeriod, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

const rangeKey = (p: AggPeriod) => `tm:analytics:range:${p}`;

/** The range last chosen for this period on this device (localStorage), else the first. */
export function savedPeriodRange(p: AggPeriod): number {
  const opts = PERIOD_RANGES[p];
  try {
    const v = Number(localStorage.getItem(rangeKey(p)));
    return opts.includes(v) ? v : opts[0]!;
  } catch {
    return opts[0]!;
  }
}
export function savePeriodRange(p: AggPeriod, n: number): void {
  try {
    localStorage.setItem(rangeKey(p), String(n));
  } catch {
    /* private mode / blocked storage: the toggle still works for this page */
  }
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** The Monday ('yyyy-mm-dd') of an ISO week key '2026-W40'. */
export function weekMonday(key: string): string {
  const [ys, ws] = key.split('-W');
  const y = Number(ys);
  const w = Number(ws);
  const jan4 = Date.UTC(y, 0, 4);
  const dow = new Date(jan4).getUTCDay() || 7;
  return msToDay(jan4 - (dow - 1) * 86_400_000 + (w - 1) * 7 * 86_400_000);
}

/** The key of the bucket `n` periods after (negative: before) `key`. */
export function addPeriods(p: AggPeriod, key: string, n: number): string {
  if (p === 'daily') return addDays(key, n);
  if (p === 'weekly') {
    const [y, m, d] = addDays(weekMonday(key), n * 7)
      .split('-')
      .map(Number) as [number, number, number];
    return isoWeekOf(y, m, d);
  }
  const [y, m] = key.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${p2((idx % 12) + 1)}`;
}

/** The `n` keys ending on the bucket `nowMs` falls in, ascending — the chart's slots (shared aggPeriodKeys). */
export const periodKeys = (p: AggPeriod, nowMs: number, n: number): string[] =>
  aggPeriodKeys(p, nowMs, n);

/** One field's buckets out of the period's docs (a doc holds every field of that period). */
export function bucketsOf(
  docs: readonly Pick<AggStats, 'key' | 'fields'>[],
  fieldId: string,
): AggBucket[] {
  const out: AggBucket[] = [];
  for (const d of docs) {
    const f = d.fields?.[fieldId];
    if (f) out.push({ key: d.key, total: f.total, count: f.count, tickets: f.tickets ?? {} });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** One slot per key, null where nothing landed (an empty slot, not a zero). */
export function fillBuckets(
  rows: readonly AggBucket[],
  keys: readonly string[],
): (AggBucket | null)[] {
  const by = new Map(rows.map((r) => [r.key, r]));
  return keys.map((k) => by.get(k) ?? null);
}

export interface BucketSum {
  total: number;
  count: number;
  /** Distinct tickets with at least one entry in the range. */
  tickets: number;
}

/** Sum of the buckets with from <= key <= to (inclusive; either bound optional). */
export function sumBuckets(rows: readonly AggBucket[], from?: string, to?: string): BucketSum {
  let total = 0;
  let count = 0;
  const keys = new Set<string>();
  for (const r of rows) {
    if (from && r.key < from) continue;
    if (to && r.key > to) continue;
    total += r.total;
    count += r.count;
    for (const [k, c] of Object.entries(r.tickets)) if (c.count > 0 || c.total !== 0) keys.add(k);
  }
  return { total: Math.round(total * 1e6) / 1e6, count, tickets: keys.size };
}

export interface TicketTotal extends AggCounter {
  key: string;
}

/** Tickets of the range, biggest total first; ties by entries, then key. */
export function rankBucketTickets(
  rows: readonly AggBucket[],
  from?: string,
  to?: string,
): TicketTotal[] {
  const acc = new Map<string, TicketTotal>();
  for (const r of rows) {
    if (from && r.key < from) continue;
    if (to && r.key > to) continue;
    for (const [key, c] of Object.entries(r.tickets)) {
      const cur = acc.get(key) ?? { key, total: 0, count: 0 };
      cur.total = Math.round((cur.total + c.total) * 1e6) / 1e6;
      cur.count += c.count;
      acc.set(key, cur);
    }
  }
  return [...acc.values()]
    .filter((t) => t.total !== 0 || t.count > 0)
    .sort((a, b) => b.total - a.total || b.count - a.count || a.key.localeCompare(b.key));
}

/** A bucket's own top tickets (the tooltip). */
export function topOfBucket(row: AggBucket | null, n = 3): TicketTotal[] {
  return row ? rankBucketTickets([row]).slice(0, n) : [];
}

export interface PeriodTile {
  id: 'current' | 'recent' | 'month';
  label: string;
  sum: BucketSum;
}

/**
 * The tiles besides the lifetime total, from the loaded buckets:
 *   daily    Today · Last 7 days · This month
 *   weekly   This week · Last 4 weeks
 *   monthly  This month · Last 3 months
 */
export function periodTiles(
  p: AggPeriod,
  rows: readonly AggBucket[],
  current: string,
): PeriodTile[] {
  if (p === 'daily')
    return [
      {
        id: 'month',
        label: 'This month',
        sum: sumBuckets(rows, current.slice(0, 7) + '-01', current),
      },
      { id: 'recent', label: 'Last 7 days', sum: sumBuckets(rows, addDays(current, -6), current) },
      { id: 'current', label: 'Today', sum: sumBuckets(rows, current, current) },
    ];
  if (p === 'weekly')
    return [
      {
        id: 'recent',
        label: 'Last 4 weeks',
        sum: sumBuckets(rows, addPeriods(p, current, -3), current),
      },
      { id: 'current', label: 'This week', sum: sumBuckets(rows, current, current) },
    ];
  return [
    {
      id: 'recent',
      label: 'Last 3 months',
      sum: sumBuckets(rows, addPeriods(p, current, -2), current),
    },
    { id: 'current', label: 'This month', sum: sumBuckets(rows, current, current) },
  ];
}

const MONTH = (key: string, month: 'short' | 'long', year = false) =>
  new Date(`${key}-02T12:00:00Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    month,
    ...(year ? { year: 'numeric' } : {}),
  });

/** The chart's x label: '3 Oct' · 'W40' · 'Oct'. */
export function shortBucket(p: AggPeriod, key: string): string {
  if (p === 'daily') return shortDay(key);
  if (p === 'weekly') return key.slice(5);
  return MONTH(key, 'short');
}

/** In full: 'Sat 3 Oct 2026' · 'Week 40 (28 Sep – 4 Oct 2026)' · 'October 2026'. */
export function longBucket(p: AggPeriod, key: string): string {
  if (p === 'daily') return longDay(key);
  if (p === 'weekly') {
    const mon = weekMonday(key);
    const sun = addDays(mon, 6);
    return `Week ${Number(key.slice(6))} (${shortDay(mon)} – ${shortDay(sun)} ${new Date(dayToMs(sun)).getUTCFullYear()})`;
  }
  return MONTH(key, 'long', true);
}

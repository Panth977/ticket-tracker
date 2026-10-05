/**
 * AGGREGATE FIELDS (docs/plan/aggregates.html) — numbers a board adds up,
 * per ticket and per period. Cost was the first (agents.html §Y): now it is
 * one aggregate field among any the board defines.
 *
 *   board.aggFields      the definitions: label, unit, period (daily |
 *                        weekly | monthly). Board settings › Aggregates.
 *   an 'agg' message     a thread message (kind 'agg', like a question is a
 *                        kind) carrying entries [{ fieldId, value }]. A
 *                        negative value takes away. It is never edited or
 *                        deleted: a correction is another entry. A turn
 *                        receipt (`run`) also counts: its costUsd is an
 *                        entry on the field 'cost' when the board has it.
 *   ticket.aggs          per field: { total, count } for that ticket.
 *   board.aggs           per field: lifetime { total, count }.
 *   aggStats/{period}:{key}
 *                        one doc per period bucket (daily:2026-10-05,
 *                        weekly:2026-W40, monthly:2026-10), with per field
 *                        { total, count, tickets: { KEY: { total, count } } }.
 *                        Fields sharing a period share the doc.
 *
 * Periods are cut in COST_DAY_TZ (the owner's clock, D-Y1); weeks are ISO
 * weeks (Monday first).
 */
import { z } from 'zod';
import { MillisSchema } from '../types/index.js';

export const AGG_PERIODS = ['daily', 'weekly', 'monthly'] as const;
export const AggPeriodSchema = z.enum(AGG_PERIODS);
export type AggPeriod = z.infer<typeof AggPeriodSchema>;

/** 'cost' (the receipts' field, kept by that id) or 'a_' + 6 [a-z0-9]. */
export const AGG_FIELD_ID_RE = /^(cost|a_[a-z0-9]{6})$/;
export const AggFieldIdSchema = z.string().regex(AGG_FIELD_ID_RE);
/** The field a turn receipt's costUsd lands on. */
export const COST_AGG_FIELD_ID = 'cost';
export const AGG_FIELDS_MAX = 20;
export const AGG_ENTRIES_MAX = 10;
/** |value| at most this (and finite). */
export const AGG_VALUE_MAX = 1e12;

export const AggFieldDefSchema = z
  .object({
    id: AggFieldIdSchema,
    label: z.string().trim().min(1).max(40),
    /** '$', 'h', 'km', 'pts'… — '' for a plain count. Currency symbols are drawn before the number. */
    unit: z.string().trim().max(12),
    period: AggPeriodSchema,
    position: z.number(),
    /** Draw the ticket's total as a chip on its card (and the lifetime total on the board bar). */
    showOnCard: z.boolean().optional(),
    /** Removed from the board: history kept, no new entries. */
    archived: z.boolean().optional(),
  })
  .strict();
export type AggFieldDef = z.infer<typeof AggFieldDefSchema>;

/** The cost field every board starts with (and the migration gives the old ones). */
export const COST_AGG_FIELD: AggFieldDef = {
  id: COST_AGG_FIELD_ID,
  label: 'Cost',
  unit: '$',
  period: 'daily',
  position: 0,
  showOnCard: true,
};

export const AggCounterSchema = z.object({
  total: z.number(),
  count: z.number().int().nonnegative(),
});
export type AggCounter = z.infer<typeof AggCounterSchema>;
export const AggCountersSchema = z.record(AggFieldIdSchema, AggCounterSchema);
export type AggCounters = z.infer<typeof AggCountersSchema>;

export const AggEntrySchema = z
  .object({
    fieldId: AggFieldIdSchema,
    value: z
      .number()
      .finite()
      .refine((v) => Math.abs(v) <= AGG_VALUE_MAX, { message: 'Too large' }),
  })
  .strict();
export type AggEntry = z.infer<typeof AggEntrySchema>;

/** Message.agg — present on a kind 'agg' message, and on a turn receipt (its cost entry). */
export const MessageAggSchema = z
  .object({
    entries: z
      .array(AggEntrySchema)
      .min(1)
      .max(AGG_ENTRIES_MAX)
      .refine((l) => new Set(l.map((e) => e.fieldId)).size === l.length, {
        message: 'One entry per field',
      }),
  })
  .strict();
export type MessageAgg = z.infer<typeof MessageAggSchema>;

/** A period bucket key: 'yyyy-mm-dd' | 'yyyy-Www' | 'yyyy-mm' — sorts as a string within a period. */
export const AGG_KEY_RE = /^\d{4}-(\d{2}-\d{2}|W\d{2}|\d{2})$/;
/** Does `key` have the shape of `period`'s keys? */
export const aggKeyFits = (period: AggPeriod, key: string): boolean =>
  period === 'daily'
    ? /^\d{4}-\d{2}-\d{2}$/.test(key)
    : period === 'weekly'
      ? /^\d{4}-W\d{2}$/.test(key)
      : /^\d{4}-\d{2}$/.test(key);

/** boards/{b}/aggStats/{period}:{key} */
export const AggStatsSchema = z.object({
  period: AggPeriodSchema,
  key: z.string().regex(AGG_KEY_RE),
  fields: z.record(
    AggFieldIdSchema,
    AggCounterSchema.extend({ tickets: z.record(z.string(), AggCounterSchema) }),
  ),
  updatedAt: MillisSchema,
});
export type AggStats = z.infer<typeof AggStatsSchema>;

/** 6-digit rounding: entries are money-like; float drift must not show. */
export const roundAgg = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Add `value` to a counter (one more entry). */
export const addAgg = (prev: AggCounter | undefined, value: number): AggCounter => ({
  total: roundAgg((prev?.total ?? 0) + value),
  count: (prev?.count ?? 0) + 1,
});

export const AGG_TZ = 'Asia/Kolkata';
const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: AGG_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function ymd(ms: number): [number, number, number] {
  const p = partsFmt.formatToParts(new Date(ms));
  const get = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return [get('year'), get('month'), get('day')];
}

/** The ISO week ('2026-W40') of a calendar date. */
export function isoWeekOf(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dow); // the week's Thursday decides its year
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The bucket key of a moment for a period, in AGG_TZ. */
export function aggPeriodKey(period: AggPeriod, ms: number): string {
  const [y, m, d] = ymd(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  if (period === 'daily') return `${y}-${p2(m)}-${p2(d)}`;
  if (period === 'monthly') return `${y}-${p2(m)}`;
  return isoWeekOf(y, m, d);
}

/**
 * The last `n` bucket keys of `period` ending at the bucket holding `endMs`,
 * oldest first — the x axis of a chart (empty buckets included).
 */
export function aggPeriodKeys(period: AggPeriod, endMs: number, n: number): string[] {
  const [y, m, d] = ymd(endMs);
  const p2 = (x: number) => String(x).padStart(2, '0');
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    if (period === 'monthly') {
      const dt = new Date(Date.UTC(y, m - 1 - i, 1));
      out.push(`${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}`);
    } else {
      const dt = new Date(Date.UTC(y, m - 1, d - (period === 'weekly' ? 7 * i : i)));
      const [yy, mm, dd] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
      out.push(period === 'daily' ? `${yy}-${p2(mm)}-${p2(dd)}` : isoWeekOf(yy, mm, dd));
    }
  }
  return out;
}

/** The aggStats doc id. */
export const aggStatsId = (period: AggPeriod, key: string): string => `${period}:${key}`;

const CURRENCY = new Set([
  '$',
  '€',
  '£',
  '₹',
  '¥',
  '₩',
  '₽',
  '₺',
  '฿',
  '₫',
  '₦',
  'A$',
  'C$',
  'US$',
]);
/** '$1.24', '-$3.00', '12.5 h', '7' — a value with its unit. */
export function formatAgg(value: number, unit: string, opts: { digits?: number } = {}): string {
  const digits = opts.digits ?? (Math.abs(value) < 1 && value !== 0 ? 4 : 2);
  const n = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: unit && CURRENCY.has(unit) ? Math.min(2, digits) : 0,
    maximumFractionDigits: digits,
  });
  const sign = value < 0 ? '-' : '';
  if (!unit) return sign + n;
  return CURRENCY.has(unit) ? `${sign}${unit}${n}` : `${sign}${n} ${unit}`;
}

/** '+$1.24 Cost' / '−2 h Time' — one entry as a line of text (signed, unit, label). */
export function formatAggEntry(value: number, field: Pick<AggFieldDef, 'label' | 'unit'>): string {
  return `${value < 0 ? '−' : '+'}${formatAgg(Math.abs(value), field.unit)} ${field.label}`;
}

/**
 * The text an agg message gets when it has no body of its own (notifications
 * and email need words): '+$1.24 Cost · −2 h Time'. Unknown fields are skipped.
 */
export function aggSummary(
  entries: readonly AggEntry[],
  fields: readonly Pick<AggFieldDef, 'id' | 'label' | 'unit'>[],
): string {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return entries
    .map((e) => {
      const f = byId.get(e.fieldId);
      return f ? formatAggEntry(e.value, f) : null;
    })
    .filter((s): s is string => s !== null)
    .join(' · ');
}

/**
 * A board's aggregate fields, in order. A board from before aggregates (no
 * `aggFields` yet — the migration adds them) behaves as if it had Cost.
 */
export function boardAggFields(board: { aggFields?: AggFieldDef[] | undefined }): AggFieldDef[] {
  return [...(board.aggFields ?? [COST_AGG_FIELD])].sort((a, b) => a.position - b.position);
}
/** The fields that take new entries. */
export const activeAggFields = (board: { aggFields?: AggFieldDef[] | undefined }): AggFieldDef[] =>
  boardAggFields(board).filter((f) => !f.archived);

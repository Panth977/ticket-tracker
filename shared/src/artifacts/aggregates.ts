/**
 * §K — a board's AGGREGATES as an artifact sees them (BackendDriver.tickets:
 * board.aggFields / board.aggs / ticket.aggs, tickets.aggregates()). Pure
 * functions over the stored shapes of docs/plan/aggregates.html, shared by
 * the broker (the host page) and its tests.
 *
 * The bucket read mirrors GET /v1/boards/{KEY}/aggregates: one field (id or
 * label), period keys inclusive, `from` defaulting to 30 days / 12 weeks /
 * 12 months back. Nothing here decides access — the broker checks the grant
 * and reads in the viewer's session.
 */
import { errors } from '../errors.js';
import {
  activeAggFields,
  aggKeyFits,
  aggPeriodKeys,
  boardAggFields,
  COST_AGG_FIELD_ID,
  roundAgg,
  type AggCounters,
  type AggFieldDef,
  type AggPeriod,
  type AggStats,
} from '../schema/aggregates.js';
import type {
  AggregateQuery,
  DriverAggBucket,
  DriverAggCounter,
  DriverAggField,
  DriverAggregates,
} from './driver.js';

/** What the aggregate reads need of a board (or a ticket, for the counters). */
export interface AggBoard {
  key: string;
  aggFields?: AggFieldDef[] | undefined;
  aggs?: AggCounters | undefined;
  cost?: { usd: number; runs: number } | undefined;
}

/** Buckets read when no `from` is given — the same as the REST GET aggregates. */
export const AGG_DEFAULT_BUCKETS: Record<AggPeriod, number> = {
  daily: 30,
  weekly: 12,
  monthly: 12,
};

export const toDriverAggField = (f: AggFieldDef): DriverAggField => ({
  id: f.id,
  label: f.label,
  unit: f.unit,
  period: f.period,
  archived: !!f.archived,
});

/**
 * `aggs` as the page sees it. A board or ticket from before aggregates only
 * has the legacy `cost` counter: it shows as `aggs.cost` (as the REST API does).
 */
export function toDriverAggCounters(d: {
  aggs?: AggCounters | undefined;
  cost?: { usd: number; runs: number } | undefined;
}): Record<string, DriverAggCounter> {
  const out: Record<string, DriverAggCounter> = {};
  if (d.cost && !d.aggs?.[COST_AGG_FIELD_ID])
    out[COST_AGG_FIELD_ID] = { total: d.cost.usd, count: d.cost.runs };
  for (const [k, v] of Object.entries(d.aggs ?? {})) out[k] = { total: v.total, count: v.count };
  return out;
}

/** A field named by id, else by label (case-insensitive; an active one wins over an archived one). */
export function aggFieldRef(board: AggBoard, ref: string): AggFieldDef {
  const fields = boardAggFields(board);
  const want = ref.trim().toLowerCase();
  const f =
    fields.find((x) => x.id === ref) ??
    fields.find((x) => !x.archived && x.label.toLowerCase() === want) ??
    fields.find((x) => x.label.toLowerCase() === want);
  if (!f)
    throw errors.invalid(
      `No aggregate field "${ref}" on ${board.key} (have: ${fields.map((x) => x.label).join(', ') || 'none'})`,
    );
  return f;
}

export interface AggPlan {
  field: AggFieldDef;
  from: string;
  to: string | null;
}

/** A query, resolved against the board and the clock. */
export function planAggregates(
  board: AggBoard,
  q: AggregateQuery | undefined,
  now: number,
): AggPlan {
  const query = q ?? {};
  if (typeof query !== 'object') throw errors.invalid('query must be an object');
  const first = activeAggFields(board)[0] ?? boardAggFields(board)[0];
  if (query.field !== undefined && typeof query.field !== 'string')
    throw errors.invalid('field must be a field id or label');
  if (!query.field && !first) throw errors.invalid(`${board.key} has no aggregate fields`);
  const field = query.field ? aggFieldRef(board, query.field) : first!;
  for (const [k, v] of [
    ['from', query.from],
    ['to', query.to],
  ] as const)
    if (v !== undefined && (typeof v !== 'string' || !aggKeyFits(field.period, v)))
      throw errors.invalid(
        `${k}: "${String(v)}" is not a ${field.period} key (${PERIOD_EXAMPLE[field.period]})`,
      );
  const from =
    query.from ?? aggPeriodKeys(field.period, now, AGG_DEFAULT_BUCKETS[field.period])[0]!;
  const to = query.to ?? null;
  if (to !== null && to < from) throw errors.invalid(`from (${from}) is after to (${to})`);
  return { field, from, to };
}

const PERIOD_EXAMPLE: Record<AggPeriod, string> = {
  daily: "like '2026-10-05'",
  weekly: "like '2026-W40'",
  monthly: "like '2026-10'",
};

/** The bucket docs (any period, any order) → the page's answer for the plan. */
export function toDriverAggregates(
  board: AggBoard,
  plan: AggPlan,
  docs: readonly Pick<AggStats, 'period' | 'key' | 'fields'>[],
): DriverAggregates {
  const { field, from, to } = plan;
  const buckets: DriverAggBucket[] = [];
  for (const d of docs) {
    if (d.period !== field.period || d.key < from || (to !== null && d.key > to)) continue;
    const c = d.fields?.[field.id];
    if (!c || c.count <= 0) continue;
    buckets.push({
      key: d.key,
      total: c.total,
      count: c.count,
      tickets: Object.fromEntries(
        Object.entries(c.tickets ?? {}).map(([k, v]) => [k, { total: v.total, count: v.count }]),
      ),
    });
  }
  buckets.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let total = 0;
  let count = 0;
  for (const b of buckets) {
    total += b.total;
    count += b.count;
  }
  return {
    field: toDriverAggField(field),
    from,
    to,
    total: roundAgg(total),
    count,
    lifetime: toDriverAggCounters(board)[field.id] ?? { total: 0, count: 0 },
    buckets,
  };
}

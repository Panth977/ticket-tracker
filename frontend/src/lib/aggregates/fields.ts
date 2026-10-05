/**
 * AGGREGATE FIELDS, READ BY THE APP (docs/plan/aggregates.html) — pure helpers
 * over a board's `aggFields` and the `aggs` counters on the board and its
 * tickets, so the chips, the settings section, the composer dialog and the
 * Analytics page all agree on what a field is and what it adds up to.
 *
 * Before the migration (scripts/migrate-aggregates.mjs) a board has no
 * `aggFields` and its counters are the legacy `cost` ({ usd, runs }): those
 * read as the Cost field, so nothing disappears on an old board.
 */
import {
  AGG_FIELDS_MAX,
  AGG_VALUE_MAX,
  activeAggFields as sharedActive,
  boardAggFields,
  COST_AGG_FIELD_ID,
  formatAgg,
  type AggCounter,
  type AggCounters,
  type AggEntry,
  type AggFieldDef,
  type CostCounter,
} from '@tm/shared';

type WithAggFields = { aggFields?: AggFieldDef[] | null; cost?: CostCounter | null };
type WithAggs = { aggs?: AggCounters | null; cost?: CostCounter | null };

/** Every field the board has defined (archived too), in order; a legacy board reads as [Cost]. */
export const allAggFields = (board: WithAggFields): AggFieldDef[] =>
  boardAggFields({ aggFields: board.aggFields ?? undefined });

/** The fields that take entries now (not archived), in order. */
export const activeAggFields = (board: WithAggFields): AggFieldDef[] =>
  sharedActive({ aggFields: board.aggFields ?? undefined });

const fromCost = (c: CostCounter | null | undefined): AggCounters =>
  c && (c.usd !== 0 || c.runs > 0) ? { [COST_AGG_FIELD_ID]: { total: c.usd, count: c.runs } } : {};

/** A board's or a ticket's counters; falls back to the legacy `cost` mirror. */
export function aggCountersOf(x: WithAggs | null | undefined): AggCounters {
  if (!x) return {};
  if (x.aggs) {
    // A doc written by the new code keeps `cost` as a mirror: aggs wins.
    if (x.aggs[COST_AGG_FIELD_ID] || !x.cost) return x.aggs;
    return { ...fromCost(x.cost), ...x.aggs };
  }
  return fromCost(x.cost);
}

export interface AggChip {
  id: string;
  label: string;
  /** '$1.24', '2.5 h' — the total with its unit. */
  text: string;
  /** 'Cost: $1.24 · 3 entries' */
  title: string;
  total: number;
  count: number;
}

export const entriesWord = (n: number) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? 'entry' : 'entries'}`;

export function chipOf(f: AggFieldDef, c: AggCounter): AggChip {
  const text = formatAgg(c.total, f.unit);
  return {
    id: f.id,
    label: f.label,
    text,
    title: `${f.label}: ${text} · ${entriesWord(c.count)}`,
    total: c.total,
    count: c.count,
  };
}

/**
 * Chips for a card or the board bar: the showOnCard fields with a non-zero
 * total, in field order. Archived fields are not drawn.
 */
export function cardChips(board: WithAggFields, counters: AggCounters): AggChip[] {
  const out: AggChip[] = [];
  for (const f of activeAggFields(board)) {
    if (!f.showOnCard) continue;
    const c = counters[f.id];
    if (c && c.total !== 0) out.push(chipOf(f, c));
  }
  return out;
}

/** The drawer header: every active field that has had an entry on this ticket. */
export function ticketChips(board: WithAggFields, counters: AggCounters): AggChip[] {
  const out: AggChip[] = [];
  for (const f of activeAggFields(board)) {
    const c = counters[f.id];
    if (c && c.count > 0) out.push(chipOf(f, c));
  }
  return out;
}

/** Once a field has entries its period is fixed: the buckets were cut by it. */
export function periodLocked(board: WithAggs, fieldId: string): boolean {
  return (aggCountersOf(board)[fieldId]?.count ?? 0) > 0;
}

/** A new field id: 'a_' + 6 [a-z0-9] (AGG_FIELD_ID_RE). */
export function aggFieldId(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const id = 'a_' + Array.from(bytes, (b) => (b % 36).toString(36)).join('');
    if (!used.has(id)) return id;
  }
}

export const canAddAggField = (fields: readonly AggFieldDef[]) => fields.length < AGG_FIELDS_MAX;

/**
 * A number as a person types it: '2.5', '-0.5', '−0.5' (a real minus),
 * '+3', '1,250.75', ' 4 '. '' → null (no entry); anything else unreadable →
 * NaN (an error to show).
 */
export function parseAggValue(raw: string): number | null {
  const s = raw.trim().replace(/[−–]/g, '-').replace(/,/g, '').replace(/\s+/g, '');
  if (!s) return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return NaN;
  return Number(s);
}

export interface AggDraftRow {
  fieldId: string;
  raw: string;
}

export interface AggDraftCheck {
  entries: AggEntry[];
  /** fieldId → what is wrong with that row. */
  errors: Record<string, string>;
  ok: boolean;
}

/** The composer dialog's rows → entries (blank and zero rows are skipped). */
export function draftEntries(rows: readonly AggDraftRow[]): AggDraftCheck {
  const entries: AggEntry[] = [];
  const errors: Record<string, string> = {};
  for (const r of rows) {
    const v = parseAggValue(r.raw);
    if (v === null) continue;
    if (!Number.isFinite(v)) errors[r.fieldId] = 'Not a number';
    else if (Math.abs(v) > AGG_VALUE_MAX) errors[r.fieldId] = 'Too large';
    else if (v !== 0) entries.push({ fieldId: r.fieldId, value: v });
  }
  return { entries, errors, ok: entries.length > 0 && Object.keys(errors).length === 0 };
}

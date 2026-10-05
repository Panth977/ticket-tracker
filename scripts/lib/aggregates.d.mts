/** Types for aggregates.mjs (loose on purpose: it takes @tm/shared and the Admin SDK as arguments). */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Shared = any;
type Doc = Record<string, any>;

export interface Counter {
  total: number;
  count: number;
}
export interface Correction {
  board?: string;
  what: string;
  have: unknown;
  want: unknown;
}
export interface Summary {
  boards: number;
  boardsToChange: number;
  aggFieldsAdded: number;
  boardCounters: number;
  tickets: number;
  ticketsToChange: number;
  ticketCounters: number;
  messages: number;
  statDays: number;
  aggStatsToWrite: number;
  corrections: Correction[];
  applied: {
    boards: number;
    tickets: number;
    aggStats: number;
    failed: { at: string; error: string }[];
  };
}

export function counterFromCost(S: Shared, c: { usd: number; runs: number } | undefined): Counter;
export function planAggFields(S: Shared, aggFields: Doc[] | undefined | null): Doc[] | null;
export function planCostCounter(
  S: Shared,
  doc: Doc | undefined,
): { set?: Counter; correction?: { have: unknown; want: Counter } };
export function planBoard(S: Shared, board: Doc): { patch: Doc | null; corrections: Correction[] };
export function aggForMessage(
  S: Shared,
  m: Doc | undefined,
): { entries: { fieldId: string; value: number }[] } | null;
export function rewriteMessages(
  S: Shared,
  messages: Doc[] | undefined,
): { messages: Doc[]; changed: number };
export function planTicket(
  S: Shared,
  ticket: Doc,
): { patch: Doc | null; corrections: Correction[]; messages: number };
export function planStatDay(
  S: Shared,
  stat: Doc,
  existing: Doc | undefined,
  now: number,
): { write: { create?: Doc; patch?: Doc } | null; correction: Correction | null };
export function migrateAggregates(
  deps: { S: Shared; db: any },
  opts: { apply: boolean; log?: (m: string) => void; now?: number },
): Promise<Summary>;

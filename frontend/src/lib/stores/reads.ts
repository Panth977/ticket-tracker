/**
 * THE READ METER (docs/plan/agents.html §W) — how many Firestore documents this
 * screen actually cost.
 *
 * §W puts a budget on the client: "a board open costs one query of ten
 * documents and a refresh pays only for what changed". A budget nobody measures
 * is a wish, so every place that can bill a read counts it here and the total
 * is published on `window.__tmReads`. qaqc/e2e/ui/reads.spec.ts opens a board,
 * opens a ticket and asserts the numbers; nothing in the app reads them.
 *
 * WHAT COUNTS. Firestore bills per DOCUMENT RETURNED BY THE SERVER, so:
 *   · a snapshot with `fromCache: true` costs nothing — it never left the tab;
 *   · a server snapshot costs one per document in `docChanges()` (the first one
 *     reports the whole result set, later ones only what moved);
 *   · establishing a listener costs at least one, even when it returns nothing
 *     (Firestore's minimum) — which is why `firstServerSnapshot` exists;
 *   · a getDoc costs one when the server answered it.
 *
 * It is therefore an ESTIMATE of the bill, not the bill — close enough to fail
 * a test when a per-card listener sneaks back in, which is the whole point.
 */

/** One line of the meter: where the reads went. */
export interface ReadMeter {
  total: number;
  byKey: Record<string, number>;
  /** Every charge in order — what a failing budget prints. */
  log: { key: string; n: number; at: number }[];
}

const MAX_LOG = 400;

let meter: ReadMeter = { total: 0, byKey: {}, log: [] };

/** The window this publishes on. Typed here so the module has no `any`. */
interface MeterWindow {
  __tmReads?: ReadMeter;
  __tmResetReads?: () => void;
}

function publish(): void {
  try {
    if (typeof window === 'undefined') return;
    const w = window as unknown as MeterWindow;
    w.__tmReads = meter;
    w.__tmResetReads ??= resetReads;
  } catch {
    /* instrumentation only — never let it break a render */
  }
}

/**
 * Count `n` documents billed under `key` (a query spec key, or a document
 * path). Nothing is recorded for 0: a listener that is up and heard no change
 * is not billed again.
 */
export function countReads(key: string, n: number): void {
  if (!(n > 0)) return;
  meter = {
    total: meter.total + n,
    byKey: { ...meter.byKey, [key]: (meter.byKey[key] ?? 0) + n },
    log:
      meter.log.length >= MAX_LOG
        ? meter.log
        : [...meter.log, { key, n, at: Math.round(performanceNow()) }],
  };
  publish();
}

/**
 * Establishing a listener costs at least one read even when the server has
 * nothing to send — that is the whole point of the '§W: a refresh pays only for
 * what changed' budget, so it must be counted. Returns a function to call with
 * each server snapshot's `docChanges().length`.
 */
export function firstServerSnapshot(key: string): (changes: number) => void {
  let first = true;
  return (changes: number) => {
    countReads(key, first ? Math.max(1, changes) : changes);
    first = false;
  };
}

function performanceNow(): number {
  try {
    return performance.now();
  } catch {
    return 0;
  }
}

/** What has been billed so far. */
export function reads(): ReadMeter {
  return meter;
}

/** Start a fresh measurement (the e2e budget calls this before each step). */
export function resetReads(): void {
  meter = { total: 0, byKey: {}, log: [] };
  publish();
}

// Published from the first import, so a test can read 0 before anything loads.
publish();

/**
 * THE DAY ROWS, LIVE (docs/plan/agents.html §Y3) — one shared listener over
 * boards/{b}/stats for the days the page is looking at. A receipt landing on
 * a ticket moves the bar while the page is open; the query is at most ~90
 * small documents and is shared through the same registry as every other
 * board store, so opening the page twice costs one listener.
 */
import { paths, type BoardDayStats } from '@tm/shared';
import { queryStore, type QueryState } from '$lib/stores';
import type { Readable } from 'svelte/store';

/** Day rows with day >= fromDay, oldest first. null board / day → an idle store. */
export function boardStats(
  boardId: string | null | undefined,
  fromDay: string | null | undefined,
): Readable<QueryState<BoardDayStats>> {
  return queryStore<BoardDayStats>(
    boardId && fromDay
      ? {
          path: paths.stats(boardId),
          where: [['day', '>=', fromDay]],
          orderBy: [['day', 'asc']],
        }
      : null,
  );
}

export const RANGES = [30, 90] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = 30;
const RANGE_KEY = 'tm:analytics:range';

/** The range last chosen on this device (localStorage), else 30. */
export function savedRange(): Range {
  try {
    const v = Number(localStorage.getItem(RANGE_KEY));
    return (RANGES as readonly number[]).includes(v) ? (v as Range) : DEFAULT_RANGE;
  } catch {
    return DEFAULT_RANGE;
  }
}

export function saveRange(r: Range): void {
  try {
    localStorage.setItem(RANGE_KEY, String(r));
  } catch {
    /* private mode / blocked storage: the toggle still works for this page */
  }
}

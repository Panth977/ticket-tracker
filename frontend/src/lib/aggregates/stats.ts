/**
 * THE PERIOD BUCKETS, LIVE (docs/plan/aggregates.html) — one shared listener
 * over boards/{b}/aggStats for the period and range the page is looking at.
 * An entry landing on a ticket moves the bar while the page is open.
 *
 * Doc ids are '{period}:{key}', so the range is a DOCUMENT-ID range
 * ['daily:2026-09-06', 'daily;') — one period, keys from `fromKey` up — which
 * needs no composite index. A doc holds every field of that period; the page
 * picks its field out (./periods › bucketsOf).
 */
import { collection, documentId, orderBy, query, where } from 'firebase/firestore';
import { aggStatsId, paths, type AggPeriod, type AggStats } from '@tm/shared';
import { getDb } from '$lib/firebase/client';
import { queryStore, type QueryState } from '$lib/stores';
import type { Readable } from 'svelte/store';

/** The bucket docs of one period with key >= fromKey, oldest first. null → an idle store. */
export function aggStatsStore(
  boardId: string | null | undefined,
  period: AggPeriod | null | undefined,
  fromKey: string | null | undefined,
): Readable<QueryState<AggStats>> {
  if (!boardId || !period || !fromKey) return queryStore<AggStats>(null);
  const lo = aggStatsId(period, fromKey);
  // ';' is the character after ':' — the end of this period's ids.
  const hi = `${period};`;
  return queryStore<AggStats>({
    key: `aggStats:${boardId}:${lo}`,
    query: () =>
      query(
        collection(getDb(), paths.aggStats(boardId)),
        where(documentId(), '>=', lo),
        where(documentId(), '<', hi),
        orderBy(documentId()),
      ),
  });
}

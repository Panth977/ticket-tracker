/**
 * Where a ticket goes inside a column. A DRAG WRITES ONE DOCUMENT: the new
 * rank is a fractional key strictly between its neighbours (shared rank.ts).
 *
 * Index: tickets (state ASC, stageId ASC, rank DESC) for the "last in column"
 * query below (REQUEST logged for the rules step).
 */
import { between } from '@tm/shared/logic/index';
import { paths, type Ticket } from '@tm/shared';
import { db } from '../runtime/firebase.js';
import type { Tx } from '../runtime/tx.js';

/** The highest rank among active tickets in a stage, or null for an empty column. */
export async function lastRankInStage(
  boardId: string,
  stageId: string,
  tx?: Tx,
): Promise<string | null> {
  const q = db()
    .collection(paths.tickets(boardId))
    .where('state', '==', 'active')
    .where('stageId', '==', stageId)
    .orderBy('rank', 'desc')
    .limit(1);
  const snap = tx ? await tx.get(q) : await q.get();
  const d = snap.docs[0];
  return d ? (d.data() as Ticket).rank : null;
}

/** Append to the bottom of a column. */
export async function rankAtEnd(boardId: string, stageId: string, tx?: Tx): Promise<string> {
  return between(await lastRankInStage(boardId, stageId, tx), null);
}

/**
 * A rank between two neighbours' ranks (either may be missing = open end).
 * Neighbours that race into the wrong order degrade to "just after `after`"
 * rather than failing the drop.
 */
export function rankBetween(after: string | null, before: string | null): string {
  if (after !== null && before !== null && after >= before) return between(after, null);
  return between(after, before);
}

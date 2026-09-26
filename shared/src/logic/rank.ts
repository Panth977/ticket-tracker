/**
 * rank — ordering inside a column or a list (backend.json proxyFunctions.rank).
 *
 * A DRAG WRITES ONE DOCUMENT. Integer positions would renumber the whole
 * column on every drop — N writes, N snapshot events, N chances to race
 * another person dragging in the same column. A fractional index is a string
 * strictly between its neighbours, so a drop only rewrites the dropped ticket.
 *
 * Keys are ASCII, so JS `<` order, Firestore's orderBy('rank') and a plain
 * `.sort()` all agree.
 */
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/**
 * A key strictly between `a` and `b`. null = open end:
 *   between(null, null)  first key in an empty list
 *   between(null, first) insert at the top
 *   between(last, null)  append
 * Throws if a >= b (the caller passed the neighbours in the wrong order or a duplicate).
 */
export function between(a: string | null | undefined, b: string | null | undefined): string {
  if (a != null && b != null && a >= b) {
    throw new RangeError(`rank.between: '${a}' must sort before '${b}'`);
  }
  return generateKeyBetween(a ?? null, b ?? null);
}

/** n evenly spread keys between a and b — bulk import, or repairing a column. */
export function betweenN(
  a: string | null | undefined,
  b: string | null | undefined,
  n: number,
): string[] {
  if (a != null && b != null && a >= b) {
    throw new RangeError(`rank.betweenN: '${a}' must sort before '${b}'`);
  }
  return generateNKeysBetween(a ?? null, b ?? null, n);
}

/** Compare ranks the way Firestore orders them (byte order; keys are ASCII). */
export function compareRank(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The rank for dropping an item at `index` in `ranks` (the list as displayed,
 * already sorted, WITHOUT the moved item).
 */
export function rankAt(ranks: readonly string[], index: number): string {
  const i = Math.max(0, Math.min(index, ranks.length));
  return between(ranks[i - 1] ?? null, ranks[i] ?? null);
}

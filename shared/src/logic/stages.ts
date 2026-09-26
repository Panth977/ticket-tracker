/**
 * The board's stages, in the order a person sees them.
 *
 * agents.html §Q3 — "a new ticket starts in the first stage". A ticket created
 * with no stage goes to the board's FIRST stage BY POSITION (the leftmost
 * kanban column), not to the first stage that happens to be of category
 * 'todo'. That is what "add it to the board" means, and it is already where a
 * column's own '+' puts it. One function, so the browser, the REST door, the
 * MCP door and the SDK cannot drift apart.
 */
import type { Stage } from '../types/board.js';

/** Stages by position (ties keep their stored order). */
export function orderedStages<S extends Pick<Stage, 'position'>>(board: {
  stages: readonly S[];
}): S[] {
  return [...board.stages].sort((a, b) => a.position - b.position);
}

/**
 * The stage a ticket lands in when none was named. A board always has at least
 * one stage (BoardSchema: stages.min(1)), so this always returns one.
 */
export function firstStage<S extends Pick<Stage, 'position'>>(board: { stages: readonly S[] }): S {
  return orderedStages(board)[0]!;
}

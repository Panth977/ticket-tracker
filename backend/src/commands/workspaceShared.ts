/**
 * Shared by the workspace commands (agents.html §AB): who may (a person, for
 * themselves), and that every id they put in a workspace is something they
 * already reach — a workspace never grants anything.
 */
import { effectiveRole, errors, isAgentId, paths } from '@tm/shared';
import { artifactRef, roleFor } from '../artifacts/shared.js';
import { memoryRef, reachFor } from '../memory/shared.js';
import type { ServerCtx } from '../runtime/context.js';
import { typedDoc } from '../runtime/converters.js';
import { txGetAll, type Tx } from '../runtime/tx.js';

export function personOnly(ctx: ServerCtx): void {
  if (isAgentId(ctx.actor)) throw errors.forbidden('Workspaces belong to people, not agents');
}

/** 400 naming every id the caller cannot open. */
export async function assertReachable(
  tx: Tx,
  ctx: ServerCtx,
  ids: {
    boardIds?: readonly string[];
    artifactIds?: readonly string[];
    /** memory.html §F */
    memoryIds?: readonly string[];
  },
): Promise<void> {
  const boardIds = [...new Set(ids.boardIds ?? [])];
  const artifactIds = [...new Set(ids.artifactIds ?? [])];
  const [boards, artifacts] = await Promise.all([
    boardIds.length
      ? txGetAll(
          tx,
          boardIds.map((id) => typedDoc('boards', paths.board(id))),
        )
      : Promise.resolve([]),
    artifactIds.length ? txGetAll(tx, artifactIds.map(artifactRef)) : Promise.resolve([]),
  ]);
  const badBoards = boardIds.filter((_, i) => {
    const b = boards[i];
    return !b || !effectiveRole(b, ctx.actor);
  });
  const badArtifacts = artifactIds.filter((_, i) => {
    const a = artifacts[i];
    return !a || !roleFor({ ...ctx, scopes: undefined }, a);
  });
  const memoryIds = [...new Set(ids.memoryIds ?? [])];
  const memories = memoryIds.length ? await txGetAll(tx, memoryIds.map(memoryRef)) : [];
  const reaches = await Promise.all(
    memories.map((m) => reachFor({ ...ctx, scopes: undefined }, m, tx)),
  );
  const badMemories = memoryIds.filter((_, i) => !reaches[i]);
  if (badBoards.length || badArtifacts.length || badMemories.length)
    throw errors.invalid('You cannot open some of these', {
      ...(badBoards.length ? { boardIds: badBoards } : {}),
      ...(badArtifacts.length ? { artifactIds: badArtifacts } : {}),
      ...(badMemories.length ? { memoryIds: badMemories } : {}),
    });
}

/** Ordered, de-duplicated. */
export const uniq = (xs: readonly string[]): string[] => [...new Set(xs)];

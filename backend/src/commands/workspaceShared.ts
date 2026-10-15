/**
 * Shared by the workspace commands (agents.html §AB): who may (a person, for
 * themselves), and that every id they put in a workspace is something they
 * already reach — a workspace never grants anything.
 */
import { effectiveRole, errors, isAgentId, paths } from '@tm/shared';
import { artifactRef, roleFor } from '../artifacts/shared.js';
import { bucketRef, reachFor } from '../bucket/shared.js';
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
    /** bucket.html §F */
    bucketIds?: readonly string[];
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
  const bucketIds = [...new Set(ids.bucketIds ?? [])];
  const buckets = bucketIds.length ? await txGetAll(tx, bucketIds.map(bucketRef)) : [];
  const reaches = await Promise.all(
    buckets.map((m) => reachFor({ ...ctx, scopes: undefined }, m, tx)),
  );
  const badBuckets = bucketIds.filter((_, i) => !reaches[i]);
  if (badBoards.length || badArtifacts.length || badBuckets.length)
    throw errors.invalid('You cannot open some of these', {
      ...(badBoards.length ? { boardIds: badBoards } : {}),
      ...(badArtifacts.length ? { artifactIds: badArtifacts } : {}),
      ...(badBuckets.length ? { bucketIds: badBuckets } : {}),
    });
}

/** Ordered, de-duplicated. */
export const uniq = (xs: readonly string[]): string[] => [...new Set(xs)];

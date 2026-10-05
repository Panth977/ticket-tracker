/**
 * workspaceUpdate (agents.html §AB) — rename, recolour, reorder, and attach /
 * detach boards and artifacts: a whole list (`boardIds`, `artifactIds`, whose
 * order is the sidebar's) or a few (`add`, `remove`). Only ids being ADDED are
 * checked; one the person lost access to may stay and simply stops showing.
 */
import { errors, paths, WORKSPACE_ITEMS_MAX, type Workspace } from '@tm/shared';
import { typedDoc } from '../runtime/converters.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { assertReachable, personOnly, uniq } from './workspaceShared.js';

export default defineCommand('workspaceUpdate', async (ctx, input) => {
  personOnly(ctx);
  await runTx(async (tx) => {
    const ref = typedDoc('workspaces', paths.workspace(ctx.actor, input.workspaceId));
    const ws = await txGet(tx, ref);
    if (!ws) throw errors.not_found('Workspace not found');
    let boardIds = input.boardIds ? uniq(input.boardIds) : ws.boardIds;
    let artifactIds = input.artifactIds ? uniq(input.artifactIds) : ws.artifactIds;
    boardIds = uniq([...boardIds, ...(input.add?.boardIds ?? [])]);
    artifactIds = uniq([...artifactIds, ...(input.add?.artifactIds ?? [])]);
    const dropB = new Set(input.remove?.boardIds ?? []);
    const dropA = new Set(input.remove?.artifactIds ?? []);
    boardIds = boardIds.filter((id) => !dropB.has(id));
    artifactIds = artifactIds.filter((id) => !dropA.has(id));
    if (boardIds.length + artifactIds.length > WORKSPACE_ITEMS_MAX)
      throw errors.invalid(`A workspace holds at most ${WORKSPACE_ITEMS_MAX} boards and artifacts`);
    const had = { b: new Set(ws.boardIds), a: new Set(ws.artifactIds) };
    await assertReachable(tx, ctx, {
      boardIds: boardIds.filter((id) => !had.b.has(id)),
      artifactIds: artifactIds.filter((id) => !had.a.has(id)),
    });
    const next: Workspace = {
      ...ws,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      boardIds,
      artifactIds,
      updatedAt: ctx.now,
    };
    tx.set(ref, next);
  });
  return { ok: true as const };
});

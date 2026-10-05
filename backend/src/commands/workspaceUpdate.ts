/**
 * workspaceUpdate (agents.html §AB) — rename, recolour, reorder, and attach /
 * detach boards and artifacts: a whole list (`boardIds`, `artifactIds`, whose
 * order is the sidebar's) or a few (`add`, `remove`). Only ids being ADDED are
 * checked; one the person lost access to may stay and simply stops showing.
 */
import { errors, paths, WORKSPACE_ITEMS_MAX, type Workspace } from '@tm/shared';
import { typedDoc } from '../runtime/converters.js';
import { runTx, txGet } from '../runtime/tx.js';
import { descriptionText } from '@tm/shared/logic/index';
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
    // memory.html §F: memories are bundled the same way.
    let memoryIds = input.memoryIds ? uniq(input.memoryIds) : (ws.memoryIds ?? []);
    memoryIds = uniq([...memoryIds, ...(input.add?.memoryIds ?? [])]);
    const dropM = new Set(input.remove?.memoryIds ?? []);
    memoryIds = memoryIds.filter((id) => !dropM.has(id));
    if (boardIds.length + artifactIds.length + memoryIds.length > WORKSPACE_ITEMS_MAX)
      throw errors.invalid(
        `A workspace holds at most ${WORKSPACE_ITEMS_MAX} boards, artifacts and memories`,
      );
    const had = {
      b: new Set(ws.boardIds),
      a: new Set(ws.artifactIds),
      m: new Set(ws.memoryIds ?? []),
    };
    await assertReachable(tx, ctx, {
      boardIds: boardIds.filter((id) => !had.b.has(id)),
      artifactIds: artifactIds.filter((id) => !had.a.has(id)),
      memoryIds: memoryIds.filter((id) => !had.m.has(id)),
    });
    const next: Workspace = {
      ...ws,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      boardIds,
      artifactIds,
      memoryIds,
      updatedAt: ctx.now,
    };
    // indicators.html: the mark, with the legacy colour kept in step.
    if (input.indicator) {
      next.indicator = input.indicator;
      if (input.color === undefined && 'color' in input.indicator)
        next.color = input.indicator.color;
    } else if (input.color !== undefined && (!ws.indicator || ws.indicator.kind === 'color')) {
      next.indicator = { kind: 'color', color: input.color };
    }
    if (input.description !== undefined) {
      const d = descriptionText(input.description);
      if (d) next.description = d;
      else delete next.description;
    }
    tx.set(ref, next);
  });
  return { ok: true as const };
});

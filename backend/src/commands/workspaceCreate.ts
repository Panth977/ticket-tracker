/**
 * workspaceCreate (agents.html §AB) — a person's own named bundle of boards
 * and artifacts, at users/{actor}/workspaces/{id}. It grants nothing.
 */
import { errors, paths, WORKSPACE_COLORS, WORKSPACES_MAX, type Workspace } from '@tm/shared';
import { descriptionText } from '@tm/shared/logic/index';
import { typedCol, typedDoc } from '../runtime/converters.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { assertReachable, personOnly, uniq } from './workspaceShared.js';

export default defineCommand('workspaceCreate', async (ctx, input) => {
  personOnly(ctx);
  const workspaceId = ctx.ids.id();
  await runTx(async (tx) => {
    const mine = await tx.get(typedCol('workspaces', paths.workspaces(ctx.actor)));
    if (mine.size >= WORKSPACES_MAX)
      throw errors.conflict(`You can have at most ${WORKSPACES_MAX} workspaces`);
    const boardIds = uniq(input.boardIds ?? []);
    const artifactIds = uniq(input.artifactIds ?? []);
    const memoryIds = uniq(input.memoryIds ?? []);
    await assertReachable(tx, ctx, { boardIds, artifactIds, memoryIds });
    const last = Math.max(-1, ...mine.docs.map((d) => d.data().position));
    // indicators.html: the mark (default: the next workspace colour), legacy colour in step.
    const indicator = input.indicator ?? {
      kind: 'color' as const,
      color: input.color ?? WORKSPACE_COLORS[mine.size % WORKSPACE_COLORS.length]!,
    };
    const description = descriptionText(input.description);
    const doc: Workspace = {
      name: input.name,
      color:
        input.color ??
        ('color' in indicator
          ? indicator.color
          : WORKSPACE_COLORS[mine.size % WORKSPACE_COLORS.length]!),
      indicator,
      ...(description ? { description } : {}),
      boardIds,
      artifactIds,
      memoryIds,
      position: last + 1,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    tx.create(typedDoc('workspaces', paths.workspace(ctx.actor, workspaceId)), doc);
  });
  return { workspaceId };
});

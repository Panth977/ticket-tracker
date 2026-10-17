/**
 * dictionaryList (dictionary.html §C) — the dictionaries the caller reaches:
 * their own (a role on it), those granted to boards they are on and, for an
 * agent, to itself. Narrowed to one board's, one artifact's or one agent's
 * (the Subscriptions lists and the driver broker).
 */
import { errors, isAgentId, paths, type DictionaryOut } from '@tm/shared';
import { loadArtifact } from '../artifacts/shared.js';
import { callerBoardRoles } from '../bucket/shared.js';
import { db } from '../db/index.js';
import { reachableDictionaries, toDictionaryOut } from '../dictionary/shared.js';
import { defineCommand } from './_registry.js';

export default defineCommand('dictionaryList', async (ctx, input) => {
  const roles = await callerBoardRoles(ctx);
  if (input.boardId && !roles.has(input.boardId)) throw errors.not_found('Board not found');
  if (input.artifactId)
    await loadArtifact(null, input.artifactId, { ...ctx, scopes: undefined }, 'open');
  if (input.agentId && input.agentId !== ctx.actor) {
    const g = (await db().doc(paths.agent(input.agentId)).get()).data() as
      { ownerUid?: string } | undefined;
    if (!g || isAgentId(ctx.actor) || g.ownerUid !== ctx.actor)
      throw errors.not_found('No such agent');
  }
  const narrow = {
    ...(input.boardId ? { boardId: input.boardId } : {}),
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
  };
  const found = await reachableDictionaries(ctx, narrow, roles);
  const out: DictionaryOut[] = [];
  for (const { id, d, reach } of found) {
    if (d.archivedAt !== null && !input.includeArchived) continue;
    const grant = input.boardId
      ? d.boards[input.boardId]
      : input.artifactId
        ? d.artifacts[input.artifactId]
        : input.agentId
          ? d.agents?.[input.agentId]
          : undefined;
    out.push({ ...toDictionaryOut(id, d, reach), ...(grant ? { grant } : {}) });
  }
  return { dictionaries: out };
});

/**
 * memoryList (memory.html §G) — the memories the caller reaches: their own
 * (a role on it) and those granted to boards they are on. Narrowed to one
 * board's (the ticket attach picker, board settings) or one artifact's (the
 * driver broker, §H).
 */
import { errors, isAgentId, memoryReach, type Memory, type MemoryOut } from '@tm/shared';
import { loadArtifact } from '../artifacts/shared.js';
import {
  callerBoardRoles,
  isBoardTokenAsPerson,
  memoriesCol,
  toMemoryOut,
} from '../memory/shared.js';
import { defineCommand } from './_registry.js';

export default defineCommand('memoryList', async (ctx, input) => {
  if (isBoardTokenAsPerson(ctx)) return { memories: [] };
  const roles = await callerBoardRoles(ctx);
  if (input.boardId && !roles.has(input.boardId)) throw errors.not_found('Board not found');
  if (input.artifactId)
    await loadArtifact(null, input.artifactId, { ...ctx, scopes: undefined }, 'open');

  const found = new Map<string, Memory>();
  if (!isAgentId(ctx.actor)) {
    const own = await memoriesCol().where('memberUids', 'array-contains', ctx.actor).get();
    for (const d of own.docs) found.set(d.id, d.data());
  }
  const boardIds = input.boardId ? [input.boardId] : [...roles.keys()];
  for (let i = 0; i < boardIds.length; i += 30) {
    const chunk = boardIds.slice(i, i + 30);
    const snap = await memoriesCol().where('boardIds', 'array-contains-any', chunk).get();
    for (const d of snap.docs) found.set(d.id, d.data());
  }

  const uid = isAgentId(ctx.actor) ? null : ctx.actor;
  const out: MemoryOut[] = [];
  for (const [id, m] of found) {
    if (m.deletingAt) continue;
    if (m.archivedAt !== null && !input.includeArchived) continue;
    if (input.boardId && !m.boards?.[input.boardId]) continue;
    if (input.artifactId && !m.artifacts?.[input.artifactId]) continue;
    const reach = memoryReach(m, { uid, boardRoles: roles });
    if (reach) out.push(toMemoryOut(id, m, reach));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { memories: out };
});

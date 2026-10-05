/**
 * memoryMove (memory.html §G) — rename and/or move one node to `toPath` (its
 * NEW full path; missing parents are created). A folder takes its whole
 * subtree: every descendant's `path` is rewritten.
 *
 * Up to SUBTREE_IN_TX descendants move in the same transaction as the node
 * (atomic). A bigger folder moves the node atomically and its descendants in
 * batches right after — paths are denormalized (D-M1), the parentId tree is
 * already right at commit, so a reader in that window sees stale `path`s only.
 */
import { errors, memoryBaseName, memoryPathWithin, type MemoryNode } from '@tm/shared';
import { db } from '../runtime/firebase.js';
import {
  assertRoom,
  bumpStats,
  cleanPath,
  nodeAt,
  planParents,
  readParents,
  readSubtree,
  readTarget,
  writeParents,
} from '../memory/nodes.js';
import { loadMemory, nodeRef } from '../memory/shared.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

const SUBTREE_IN_TX = 400;

export default defineCommand('memoryMove', async (ctx, input) => {
  const { memoryId } = input;
  const toPath = cleanPath(input.toPath, 'toPath');
  const res = await runTx(async (tx) => {
    const { memory } = await loadMemory(tx, memoryId, ctx, 'write');
    const node = await readTarget(tx, memoryId, input);
    const from = node.node.path;
    if (from === toPath)
      return { nodeId: node.id, path: toPath, later: [] as { id: string; path: string }[] };
    if (node.node.kind === 'folder' && memoryPathWithin(toPath, from))
      throw errors.conflict('A folder cannot move inside itself', { path: toPath });
    if (await nodeAt(memoryId, toPath, tx))
      throw errors.conflict(`Something is already at ${toPath}`, { path: toPath });
    const parents = await readParents(tx, memoryId, toPath);
    const subtree = node.node.kind === 'folder' ? await readSubtree(memoryId, from, tx) : [];

    const plan = planParents(ctx, toPath, parents);
    assertRoom(memory, plan.create.length);
    writeParents(tx, memoryId, plan);
    const patch: Partial<MemoryNode> = {
      parentId: plan.parentId,
      name: memoryBaseName(toPath),
      path: toPath,
      updatedAt: ctx.now,
      updatedBy: ctx.actor,
    };
    tx.update(nodeRef(memoryId, node.id), patch);
    const moved = subtree.map((d) => ({ id: d.id, path: toPath + d.node.path.slice(from.length) }));
    const now = moved.length <= SUBTREE_IN_TX ? moved : [];
    for (const d of now) tx.update(nodeRef(memoryId, d.id), { path: d.path });
    bumpStats(tx, memoryId, { folders: plan.create.length }, ctx.now);
    return { nodeId: node.id, path: toPath, later: moved.length > SUBTREE_IN_TX ? moved : [] };
  });
  for (let i = 0; i < res.later.length; i += 450) {
    const b = db().batch();
    for (const d of res.later.slice(i, i + 450))
      b.update(nodeRef(memoryId, d.id), { path: d.path });
    await b.commit();
  }
  return { nodeId: res.nodeId, path: res.path };
});

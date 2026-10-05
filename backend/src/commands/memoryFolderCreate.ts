/** memoryFolderCreate (memory.html §G) — mkdir -p; an existing folder is not an error. */
import { errors, memoryBaseName } from '@tm/shared';
import {
  assertRoom,
  bumpStats,
  cleanPath,
  folderNode,
  nodeAt,
  planParents,
  readParents,
  writeParents,
} from '../memory/nodes.js';
import { loadMemory, nodeRef } from '../memory/shared.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

export default defineCommand('memoryFolderCreate', async (ctx, input) => {
  const { memoryId } = input;
  const path = cleanPath(input.path);
  return runTx(async (tx) => {
    const { memory } = await loadMemory(tx, memoryId, ctx, 'write');
    const here = await nodeAt(memoryId, path, tx);
    if (here) {
      if (here.node.kind !== 'folder') throw errors.conflict(`${path} is a file`, { path });
      return { nodeId: here.id, path };
    }
    const plan = planParents(ctx, path, await readParents(tx, memoryId, path));
    assertRoom(memory, plan.create.length + 1);
    writeParents(tx, memoryId, plan);
    const nodeId = ctx.ids.id();
    tx.create(
      nodeRef(memoryId, nodeId),
      folderNode(ctx.actor, ctx.now, plan.parentId, memoryBaseName(path), path),
    );
    bumpStats(tx, memoryId, { folders: plan.create.length + 1 }, ctx.now);
    return { nodeId, path };
  });
});

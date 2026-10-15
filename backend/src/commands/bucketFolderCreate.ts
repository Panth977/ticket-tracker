/** bucketFolderCreate (bucket.html §G) — mkdir -p; an existing folder is not an error. */
import { errors, bucketBaseName } from '@tm/shared';
import {
  assertRoom,
  bumpStats,
  cleanPath,
  folderNode,
  nodeAt,
  planParents,
  readParents,
  writeParents,
} from '../bucket/nodes.js';
import { loadBucket, nodeRef } from '../bucket/shared.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

export default defineCommand('bucketFolderCreate', async (ctx, input) => {
  const { bucketId } = input;
  const path = cleanPath(input.path);
  return runTx(async (tx) => {
    const { bucket } = await loadBucket(tx, bucketId, ctx, 'write');
    const here = await nodeAt(bucketId, path, tx);
    if (here) {
      if (here.node.kind !== 'folder') throw errors.conflict(`${path} is a file`, { path });
      return { nodeId: here.id, path };
    }
    const plan = planParents(ctx, path, await readParents(tx, bucketId, path));
    assertRoom(bucket, plan.create.length + 1);
    writeParents(tx, bucketId, plan);
    const nodeId = ctx.ids.id();
    tx.create(
      nodeRef(bucketId, nodeId),
      folderNode(ctx.actor, ctx.now, plan.parentId, bucketBaseName(path), path),
    );
    bumpStats(tx, bucketId, { folders: plan.create.length + 1 }, ctx.now);
    return { nodeId, path };
  });
});

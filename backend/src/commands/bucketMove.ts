/**
 * bucketMove (bucket.html §G) — rename and/or move one node to `toPath` (its
 * NEW full path; missing parents are created). A folder takes its whole
 * subtree: every descendant's `path` is rewritten.
 *
 * Up to SUBTREE_IN_TX descendants move in the same transaction as the node
 * (atomic). A bigger folder moves the node atomically and its descendants in
 * batches right after — paths are denormalized (D-M1), the parentId tree is
 * already right at commit, so a reader in that window sees stale `path`s only.
 */
import { errors, bucketBaseName, bucketPathWithin, type BucketNode } from '@tm/shared';
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
} from '../bucket/nodes.js';
import { loadBucket, nodeRef } from '../bucket/shared.js';
import { runTx } from '../runtime/tx.js';
import { driveMove, isDriveBucket, openDrive } from '../bucket/drive/store.js';
import { defineCommand } from './_registry.js';

const SUBTREE_IN_TX = 400;

export default defineCommand('bucketMove', async (ctx, input) => {
  const { bucketId } = input;
  const toPath = cleanPath(input.toPath, 'toPath');
  const pre = await loadBucket(null, bucketId, ctx, 'write');
  if (isDriveBucket(pre.bucket))
    return driveMove(await openDrive(bucketId, pre.bucket), input, toPath, ctx.actor);
  const res = await runTx(async (tx) => {
    const { bucket } = await loadBucket(tx, bucketId, ctx, 'write');
    const node = await readTarget(tx, bucketId, input);
    const from = node.node.path;
    if (from === toPath)
      return { nodeId: node.id, path: toPath, later: [] as { id: string; path: string }[] };
    if (node.node.kind === 'folder' && bucketPathWithin(toPath, from))
      throw errors.conflict('A folder cannot move inside itself', { path: toPath });
    if (await nodeAt(bucketId, toPath, tx))
      throw errors.conflict(`Something is already at ${toPath}`, { path: toPath });
    const parents = await readParents(tx, bucketId, toPath);
    const subtree = node.node.kind === 'folder' ? await readSubtree(bucketId, from, tx) : [];

    const plan = planParents(ctx, toPath, parents);
    assertRoom(bucket, plan.create.length);
    writeParents(tx, bucketId, plan);
    const patch: Partial<BucketNode> = {
      parentId: plan.parentId,
      name: bucketBaseName(toPath),
      path: toPath,
      updatedAt: ctx.now,
      updatedBy: ctx.actor,
    };
    tx.update(nodeRef(bucketId, node.id), patch);
    const moved = subtree.map((d) => ({ id: d.id, path: toPath + d.node.path.slice(from.length) }));
    const now = moved.length <= SUBTREE_IN_TX ? moved : [];
    for (const d of now) tx.update(nodeRef(bucketId, d.id), { path: d.path });
    bumpStats(tx, bucketId, { folders: plan.create.length }, ctx.now);
    return { nodeId: node.id, path: toPath, later: moved.length > SUBTREE_IN_TX ? moved : [] };
  });
  for (let i = 0; i < res.later.length; i += 450) {
    const b = db().batch();
    for (const d of res.later.slice(i, i + 450))
      b.update(nodeRef(bucketId, d.id), { path: d.path });
    await b.commit();
  }
  return { nodeId: res.nodeId, path: res.path };
});

/**
 * bucketTree (bucket.html §G) — the nodes under a folder (default: all), for
 * callers that do not read Firestore directly (REST, MCP, board members who
 * reach the bucket through a grant, the driver). Sorted by path.
 */
import { errors, BUCKET_NODES_MAX } from '@tm/shared';
import { cleanPath, nodeAt, readSubtree } from '../bucket/nodes.js';
import { loadBucket, nodesCol, toNodeOut } from '../bucket/shared.js';
import { driveStatsFrom, driveTree, isDriveBucket, openDrive } from '../bucket/drive/store.js';
import { defineCommand } from './_registry.js';

export default defineCommand('bucketTree', async (ctx, input) => {
  const { bucketId } = input;
  const { bucket } = await loadBucket(null, bucketId, ctx, 'read');
  const folder = cleanPath(input.path ?? '', 'path', true);
  if (isDriveBucket(bucket)) {
    // §K2: the tree IS Drive's, read now.
    const d = await openDrive(bucketId, bucket);
    const { rows } = await driveTree(d, folder, { shallow: !!input.shallow });
    if (folder === '' && !input.shallow && rows.length <= BUCKET_NODES_MAX)
      await driveStatsFrom(bucketId, bucket, rows, ctx.now);
    return {
      nodes: rows.slice(0, BUCKET_NODES_MAX).map((r) => toNodeOut(r.id, r.node)),
      truncated: rows.length > BUCKET_NODES_MAX,
    };
  }
  let folderId: string | null = null;
  if (folder !== '') {
    const f = await nodeAt(bucketId, folder);
    if (!f) throw errors.not_found(`Nothing at ${folder} in this bucket`, { path: folder });
    if (f.node.kind !== 'folder') throw errors.invalid(`${folder} is a file`, { field: 'path' });
    folderId = f.id;
  }
  let rows;
  if (input.shallow) {
    const snap = await nodesCol(bucketId)
      .where('parentId', '==', folderId)
      .limit(BUCKET_NODES_MAX + 1)
      .get();
    rows = snap.docs.map((d) => ({ id: d.id, node: d.data() }));
  } else rows = await readSubtree(bucketId, folder);
  const truncated = rows.length > BUCKET_NODES_MAX;
  const nodes = rows
    .slice(0, BUCKET_NODES_MAX)
    .map((r) => toNodeOut(r.id, r.node))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { nodes, truncated };
});

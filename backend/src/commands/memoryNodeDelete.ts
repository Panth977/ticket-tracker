/**
 * memoryNodeDelete (memory.html §G) — delete files and folders; a folder goes
 * with everything under it. Nodes and counters go in batches of 450 (each
 * batch moves the counters by exactly what it removed); the Storage objects
 * are deleted after. Tickets pointing at a deleted file keep a row that reads
 * as gone (§E).
 */
import { errors } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { db } from '../runtime/firebase.js';
import { bumpStats, readSubtree, readTarget, type Found } from '../memory/nodes.js';
import { loadMemory, nodeRef } from '../memory/shared.js';
import { defineCommand } from './_registry.js';

export default defineCommand('memoryNodeDelete', async (ctx, input) => {
  const { memoryId } = input;
  await loadMemory(null, memoryId, ctx, 'write');
  const targets: Found[] = [];
  for (const path of input.paths ?? []) targets.push(await readTarget(null, memoryId, { path }));
  for (const nodeId of input.nodeIds ?? [])
    targets.push(await readTarget(null, memoryId, { nodeId }));
  if (!targets.length) throw errors.invalid('Nothing to delete', { field: 'paths' });

  const all = new Map<string, Found>();
  for (const t of targets) {
    all.set(t.id, t);
    if (t.node.kind === 'folder')
      for (const d of await readSubtree(memoryId, t.node.path)) all.set(d.id, d);
  }
  const rows = [...all.values()];
  for (let i = 0; i < rows.length; i += 450) {
    const chunk = rows.slice(i, i + 450);
    const b = db().batch();
    for (const r of chunk) b.delete(nodeRef(memoryId, r.id));
    const files = chunk.filter((r) => r.node.kind === 'file');
    bumpStats(
      b,
      memoryId,
      {
        files: -files.length,
        folders: -(chunk.length - files.length),
        bytes: -files.reduce((n, r) => n + (r.node.file?.size ?? 0), 0),
      },
      ctx.now,
    );
    await b.commit();
  }
  const objects = rows.map((r) => r.node.file?.storagePath).filter((p): p is string => !!p);
  await Promise.all(
    objects.map((p) =>
      ports()
        .files.delete(p)
        .catch((e) => console.warn('[memory] could not delete', p, e)),
    ),
  );
  return { deleted: rows.length };
});

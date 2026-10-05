/**
 * memoryTree (memory.html §G) — the nodes under a folder (default: all), for
 * callers that do not read Firestore directly (REST, MCP, board members who
 * reach the memory through a grant, the driver). Sorted by path.
 */
import { errors, MEMORY_NODES_MAX } from '@tm/shared';
import { cleanPath, nodeAt, readSubtree } from '../memory/nodes.js';
import { loadMemory, nodesCol, toNodeOut } from '../memory/shared.js';
import { defineCommand } from './_registry.js';

export default defineCommand('memoryTree', async (ctx, input) => {
  const { memoryId } = input;
  await loadMemory(null, memoryId, ctx, 'read');
  const folder = cleanPath(input.path ?? '', 'path', true);
  let folderId: string | null = null;
  if (folder !== '') {
    const f = await nodeAt(memoryId, folder);
    if (!f) throw errors.not_found(`Nothing at ${folder} in this memory`, { path: folder });
    if (f.node.kind !== 'folder') throw errors.invalid(`${folder} is a file`, { field: 'path' });
    folderId = f.id;
  }
  let rows;
  if (input.shallow) {
    const snap = await nodesCol(memoryId)
      .where('parentId', '==', folderId)
      .limit(MEMORY_NODES_MAX + 1)
      .get();
    rows = snap.docs.map((d) => ({ id: d.id, node: d.data() }));
  } else rows = await readSubtree(memoryId, folder);
  const truncated = rows.length > MEMORY_NODES_MAX;
  const nodes = rows
    .slice(0, MEMORY_NODES_MAX)
    .map((r) => toNodeOut(r.id, r.node))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { nodes, truncated };
});

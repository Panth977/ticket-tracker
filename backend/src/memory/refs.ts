/**
 * MEMORY FILES ON TICKETS (memory.html §E) — a reference, not a copy.
 *
 * messagePost / ticketCreate name { memoryId, nodeId }s; each becomes an
 * Attachment whose `path` is the virtual memoryRefPath and whose `memory`
 * says what it points at. Nothing is uploaded and the ticket's storage does
 * not grow; the file door resolves the path to the node's current version.
 *
 * Attaching needs the memory GRANTED TO THIS BOARD (read or write) — the
 * caller's right to comment on the board is checked by the command itself.
 * name / mime / size are copied from the node as it is now (the row's label).
 */
import {
  errors,
  memoryRefPath,
  type Attachment,
  type MemoryRef,
  type PublicMemoryFileRef,
} from '@tm/shared';
import { cleanPath, nodeAt } from './nodes.js';
import type { ServerCtx } from '../runtime/context.js';
import { memoryRef, nodeRef } from './shared.js';

export async function resolveMemoryRefs(
  ctx: Pick<ServerCtx, 'actor' | 'ids'>,
  refs: readonly MemoryRef[] | undefined,
  boardId: string,
): Promise<Attachment[]> {
  const seen = new Set<string>();
  const list = (refs ?? []).filter((r) => {
    const k = `${r.memoryId}/${r.nodeId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const memories = new Map<string, Awaited<ReturnType<typeof loadGranted>>>();
  async function loadGranted(memoryId: string) {
    const m = (await memoryRef(memoryId).get()).data();
    if (!m || m.deletingAt || !m.boards?.[boardId])
      throw errors.invalid(
        'That memory is not available on this board — grant it in board settings › Memory',
        {
          field: 'memoryRefs',
          memoryId,
        },
      );
    return m;
  }
  const out: Attachment[] = [];
  for (const r of list) {
    if (!memories.has(r.memoryId)) memories.set(r.memoryId, await loadGranted(r.memoryId));
    const node = (await nodeRef(r.memoryId, r.nodeId).get()).data();
    if (!node || node.kind !== 'file' || !node.file)
      throw errors.invalid('That memory file does not exist (any more)', {
        field: 'memoryRefs',
        nodeId: r.nodeId,
      });
    out.push({
      id: ctx.ids.id(),
      path: memoryRefPath(r.memoryId, r.nodeId),
      name: node.name.slice(0, 255),
      mime: node.file.mime,
      size: node.file.size,
      ...(node.file.width && node.file.height
        ? { width: node.file.width, height: node.file.height }
        : {}),
      uploadedBy: ctx.actor,
      memory: { memoryId: r.memoryId, nodeId: r.nodeId },
    });
  }
  return out;
}

/**
 * { memory_id, node_id | path } (REST / MCP) → { memoryId, nodeId }. A path is
 * looked up in the memory; whether the caller may attach it is still
 * resolveMemoryRefs' (the grant to the board) and the command's (comment).
 */
export async function memoryRefsIn(
  list: readonly PublicMemoryFileRef[] | undefined,
): Promise<MemoryRef[] | undefined> {
  if (!list?.length) return undefined;
  return Promise.all(
    list.map(async (r) => {
      if (r.node_id) return { memoryId: r.memory_id, nodeId: r.node_id };
      const found = await nodeAt(r.memory_id, cleanPath(r.path ?? '', 'memory_files'));
      if (!found)
        throw errors.invalid(`Nothing at ${r.path} in that memory`, { field: 'memory_files' });
      return { memoryId: r.memory_id, nodeId: found.id };
    }),
  );
}

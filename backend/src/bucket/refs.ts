/**
 * BUCKET FILES ON TICKETS (bucket.html §E) — a reference, not a copy.
 *
 * messagePost / ticketCreate name { bucketId, nodeId }s; each becomes an
 * Attachment whose `path` is the virtual bucketRefPath and whose `bucket`
 * says what it points at. Nothing is uploaded and the ticket's storage does
 * not grow; the file door resolves the path to the node's current version.
 *
 * Attaching needs the bucket GRANTED TO THIS BOARD (read or write) — the
 * caller's right to comment on the board is checked by the command itself.
 * name / mime / size are copied from the node as it is now (the row's label).
 */
import {
  errors,
  bucketRefPath,
  type Attachment,
  type BucketRef,
  type PublicBucketFileRef,
} from '@tm/shared';
import { cleanPath } from './nodes.js';
import type { ServerCtx } from '../runtime/context.js';
import { nodeById, nodeByPath } from './lookup.js';
import { bucketRef } from './shared.js';

export async function resolveBucketRefs(
  ctx: Pick<ServerCtx, 'actor' | 'ids'>,
  refs: readonly BucketRef[] | undefined,
  boardId: string,
): Promise<Attachment[]> {
  const seen = new Set<string>();
  const list = (refs ?? []).filter((r) => {
    const k = `${r.bucketId}/${r.nodeId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const buckets = new Map<string, Awaited<ReturnType<typeof loadGranted>>>();
  async function loadGranted(bucketId: string) {
    const m = (await bucketRef(bucketId).get()).data();
    if (!m || m.deletingAt || !m.boards?.[boardId])
      throw errors.invalid(
        'That bucket is not available on this board — grant it in board settings › Bucket',
        {
          field: 'bucketRefs',
          bucketId,
        },
      );
    return m;
  }
  const out: Attachment[] = [];
  for (const r of list) {
    if (!buckets.has(r.bucketId)) buckets.set(r.bucketId, await loadGranted(r.bucketId));
    const node = await nodeById(r.bucketId, r.nodeId, buckets.get(r.bucketId));
    if (!node || node.kind !== 'file' || !node.file)
      throw errors.invalid('That bucket file does not exist (any more)', {
        field: 'bucketRefs',
        nodeId: r.nodeId,
      });
    out.push({
      id: ctx.ids.id(),
      path: bucketRefPath(r.bucketId, r.nodeId),
      name: node.name.slice(0, 255),
      mime: node.file.mime,
      size: node.file.size,
      ...(node.file.width && node.file.height
        ? { width: node.file.width, height: node.file.height }
        : {}),
      uploadedBy: ctx.actor,
      bucket: { bucketId: r.bucketId, nodeId: r.nodeId },
    });
  }
  return out;
}

/**
 * { bucket_id, node_id | path } (REST / MCP) → { bucketId, nodeId }. A path is
 * looked up in the bucket; whether the caller may attach it is still
 * resolveBucketRefs' (the grant to the board) and the command's (comment).
 */
export async function bucketRefsIn(
  list: readonly PublicBucketFileRef[] | undefined,
): Promise<BucketRef[] | undefined> {
  if (!list?.length) return undefined;
  return Promise.all(
    list.map(async (r) => {
      if (r.node_id) return { bucketId: r.bucket_id, nodeId: r.node_id };
      const found = await nodeByPath(r.bucket_id, cleanPath(r.path ?? '', 'bucket_files'));
      if (!found)
        throw errors.invalid(`Nothing at ${r.path} in that bucket`, { field: 'bucket_files' });
      return { bucketId: r.bucket_id, nodeId: found.id };
    }),
  );
}

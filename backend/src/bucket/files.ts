/**
 * BUCKET FILES (docs/plan/bucket.html §A, D-M2) — a new version is a new
 * object. The bytes are written FIRST (by the app straight to Storage, or by
 * writeBytes here), then one transaction points the node at the new file id;
 * only after it commits is the old object deleted. A reader therefore never
 * sees a half-written file, and a failed save leaves the old version intact.
 */
import {
  errors,
  fileInfo,
  bucketBaseName,
  bucketStoragePath,
  BUCKET_INLINE_MAX_BYTES,
  type BucketFile,
  type BucketNode,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import type { ServerCtx } from '../runtime/context.js';
import { runTx } from '../runtime/tx.js';
import {
  assertRoom,
  bumpStats,
  cleanPath,
  planParents,
  readParents,
  readTarget,
  nodeAt,
  writeParents,
  type Found,
} from './nodes.js';
import { loadBucket, nodeRef, nodesCol } from './shared.js';
import { bytesSource } from './drive/api.js';
import { drivePut, isDriveBucket, openDrive } from './drive/store.js';

export interface FileTarget {
  path?: string | undefined;
  nodeId?: string | undefined;
}

export interface PutResult {
  nodeId: string;
  fileId: string;
  path: string;
}

/** The Storage name segment: percent-encoded, like ticket attachments. */
export const storageNameOf = (name: string) => encodeURIComponent(name);

/** Upload inline bytes as a NEW object; returns the file facts (not yet on a node). */
export async function writeBytes(
  ctx: Pick<ServerCtx, 'ids'>,
  bucketId: string,
  name: string,
  bytes: Uint8Array,
  mimeIn?: string | null,
  /** BUCKET_INLINE_MAX_BYTES for text / base64 in JSON; REST's raw PUT allows its own body limit. */
  limit = BUCKET_INLINE_MAX_BYTES,
): Promise<BucketFile> {
  if (bytes.byteLength > limit)
    throw errors.too_large(
      `A file written through the API is limited to ${Math.round(limit / 1024 / 1024)} MB — upload it in the app`,
      { size: bytes.byteLength, limit },
    );
  const fileId = ctx.ids.id();
  const mime = (mimeIn && mimeIn.trim()) || fileInfo(null, name).mime || 'application/octet-stream';
  const storagePath = bucketStoragePath(bucketId, fileId, storageNameOf(name));
  await ports().files.write(storagePath, bytes, mime);
  return { fileId, storagePath, mime, size: bytes.byteLength };
}

/** The name a target will have: the node's own, or the last segment of the path. */
export async function targetName(bucketId: string, t: FileTarget): Promise<string> {
  if (t.path !== undefined) return bucketBaseName(cleanPath(t.path));
  const found = await readTarget(null, bucketId, t);
  return found.node.name;
}

/**
 * Point the target at `file` (create it, with its parents, when a path names
 * nothing yet). Write reach; `expectedFileId` (when given) must match the
 * current version — null meaning "must not exist yet". The old object is
 * deleted after the commit. On ANY failure the new object is deleted.
 */
export async function putVersion(
  ctx: ServerCtx,
  bucketId: string,
  t: FileTarget,
  file: BucketFile,
  expectedFileId?: string | null | undefined,
): Promise<PutResult> {
  let old: string | null = null;
  // Set when the object turns out to be someone else's: then it must survive our failure.
  let foreign = false;
  try {
    const res = await runTx(async (tx) => {
      const { bucket } = await loadBucket(tx, bucketId, ctx, 'write');
      // ── reads ──
      let existing: Found | null;
      let path: string;
      let parents: Awaited<ReturnType<typeof readParents>> = [];
      if (t.nodeId) {
        existing = await readTarget(tx, bucketId, t);
        path = existing.node.path;
      } else {
        path = cleanPath(t.path ?? '');
        existing = await nodeAt(bucketId, path, tx);
        if (!existing) parents = await readParents(tx, bucketId, path);
      }
      // The same object must never back two nodes: deleting one would take the other's bytes.
      const sharing = await tx.get(
        nodesCol(bucketId).where('file.fileId', '==', file.fileId).limit(2),
      );
      const other = sharing.docs.find((d) => d.id !== existing?.id);
      if (other) {
        foreign = true;
        throw errors.conflict('That upload is already a file in this bucket');
      }
      if (existing?.node.file?.fileId === file.fileId)
        return { nodeId: existing.id, fileId: file.fileId, path, replaced: null as string | null };

      if (existing && existing.node.kind !== 'file')
        throw errors.conflict(`${path} is a folder`, { path });
      const current = existing?.node.file?.fileId ?? null;
      if (expectedFileId !== undefined && expectedFileId !== current)
        throw errors.conflict('This file changed since you opened it', {
          reason: 'stale',
          currentFileId: current,
        });

      // ── writes ──
      if (existing) {
        const prev = existing.node.file;
        const patch: Partial<BucketNode> = { file, updatedAt: ctx.now, updatedBy: ctx.actor };
        tx.update(nodeRef(bucketId, existing.id), patch);
        bumpStats(tx, bucketId, { bytes: file.size - (prev?.size ?? 0) }, ctx.now);
        return {
          nodeId: existing.id,
          fileId: file.fileId,
          path,
          replaced: prev?.storagePath ?? null,
        };
      }
      const plan = planParents(ctx, path, parents);
      assertRoom(bucket, plan.create.length + 1);
      writeParents(tx, bucketId, plan);
      const nodeId = ctx.ids.id();
      const node: BucketNode = {
        kind: 'file',
        parentId: plan.parentId,
        name: bucketBaseName(path),
        path,
        file,
        createdAt: ctx.now,
        createdBy: ctx.actor,
        updatedAt: ctx.now,
        updatedBy: ctx.actor,
      };
      tx.create(nodeRef(bucketId, nodeId), node);
      bumpStats(tx, bucketId, { files: 1, folders: plan.create.length, bytes: file.size }, ctx.now);
      return { nodeId, fileId: file.fileId, path, replaced: null };
    });
    old = res.replaced;
    return { nodeId: res.nodeId, fileId: res.fileId, path: res.path };
  } catch (e) {
    if (!foreign)
      await ports()
        .files.delete(file.storagePath)
        .catch(() => {});
    throw e;
  } finally {
    if (old && old !== file.storagePath)
      await ports()
        .files.delete(old)
        .catch((err) => console.warn('[bucket] could not delete an old version', old, err));
  }
}

/**
 * REST's raw PUT (and anything else holding bytes): store a new version at
 * `path`. Not a command of its own — the bytes are not JSON — but the same
 * reach check and the same putVersion as bucketFileWrite.
 */
export async function bucketRawPut(
  ctx: ServerCtx,
  bucketId: string,
  path: string,
  bytes: Uint8Array,
  mime: string | undefined,
  limit: number,
): Promise<PutResult> {
  const { bucket } = await loadBucket(null, bucketId, ctx, 'write');
  const clean = cleanPath(path);
  const type = mime && !/^application\/octet-stream/.test(mime) ? mime.split(';')[0]!.trim() : null;
  if (isDriveBucket(bucket)) {
    if (bytes.byteLength > limit)
      throw errors.too_large('This file is over the limit for this door', {
        size: bytes.byteLength,
        limit,
      });
    return drivePut(
      await openDrive(bucketId, bucket),
      { path: clean },
      bytesSource(bytes),
      type,
      ctx.actor,
    );
  }
  const file = await writeBytes(ctx, bucketId, bucketBaseName(clean), bytes, type, limit);
  return putVersion(ctx, bucketId, { path: clean }, file);
}

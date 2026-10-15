/**
 * BUCKET NODES (docs/plan/bucket.html §A) — paths inside one bucket.
 *
 * A node is found by its full `path` (unique in the bucket) or by its id. A
 * transaction READS FIRST and writes after, so every operation here comes in
 * two halves: `read…` (queries in the transaction — Firestore's server
 * transactions lock what a query read, so two writers racing for the same
 * path cannot both see it free) and `write…`.
 *
 * Folders a path needs are created on the way ("mkdir -p"); a FILE in the
 * way is a 409.
 */
import {
  errors,
  bucketParentPath,
  BUCKET_NODES_MAX,
  normalizeBucketPath,
  splitBucketPath,
  type Bucket,
  type BucketNode,
  type PrincipalId,
} from '@tm/shared';
import { FieldValue } from '../db/index.js';
import type { ServerCtx } from '../runtime/context.js';
import { txGet, type Tx } from '../runtime/tx.js';
import { nodeRef, nodesCol, rawBucketRef } from './shared.js';
import type { DocumentReference } from '../db/index.js';

export interface Found {
  id: string;
  node: BucketNode;
}

/** A path a caller typed → canonical, or a 400 naming the field. */
export function cleanPath(input: string, field = 'path', allowRoot = false): string {
  const p = normalizeBucketPath(input);
  if (p === null) throw errors.invalid('Not a valid path in a bucket', { field, path: input });
  if (p === '' && !allowRoot)
    throw errors.invalid('Name a file or folder, not the root', { field });
  return p;
}

/** The node at `path` (read in `tx` when given), or null. */
export async function nodeAt(bucketId: string, path: string, tx?: Tx): Promise<Found | null> {
  const q = nodesCol(bucketId).where('path', '==', path).limit(2);
  const snap = tx ? await tx.get(q) : await q.get();
  const d = snap.docs[0];
  return d ? { id: d.id, node: d.data() } : null;
}

/** A node by id or by path — exactly one is given (the request schema says so). */
export async function readTarget(
  tx: Tx | null,
  bucketId: string,
  t: { path?: string | undefined; nodeId?: string | undefined },
): Promise<Found> {
  if (t.nodeId) {
    const ref = nodeRef(bucketId, t.nodeId);
    const node = tx ? await txGet(tx, ref) : (await ref.get()).data();
    if (!node) throw errors.not_found('No such file or folder in this bucket');
    return { id: t.nodeId, node };
  }
  const path = cleanPath(t.path ?? '');
  const found = await nodeAt(bucketId, path, tx ?? undefined);
  if (!found) throw errors.not_found(`Nothing at ${path} in this bucket`, { path });
  return found;
}

/** Every node strictly under a folder path ('' = the whole bucket). */
export async function readSubtree(
  bucketId: string,
  folderPath: string,
  tx?: Tx,
  limit = BUCKET_NODES_MAX + 1,
): Promise<Found[]> {
  const col = nodesCol(bucketId);
  const q =
    folderPath === ''
      ? col.limit(limit)
      : col
          // Everything that starts with 'folder/' sorts between 'folder/' and
          // 'folder0' ('0' is the character after '/'). NOT '/\uf8ff': Firestore
          // orders strings by their UTF-8 bytes, and every emoji (🐺.jpeg) sorts
          // above U+F8FF — such names were left behind when their folder moved.
          .where('path', '>', folderPath + '/')
          .where('path', '<', folderPath + '0')
          .limit(limit);
  const snap = tx ? await tx.get(q) : await q.get();
  return snap.docs.map((d) => ({ id: d.id, node: d.data() }));
}

/**
 * The read half of "make sure the folders above `path` exist": the node (or
 * null) at every PARENT prefix of `path`, root first.
 */
export async function readParents(
  tx: Tx,
  bucketId: string,
  path: string,
): Promise<(Found | null)[]> {
  const segs = splitBucketPath(path) ?? [];
  const prefixes = segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join('/'));
  return Promise.all(prefixes.map((p) => nodeAt(bucketId, p, tx)));
}

export interface ParentPlan {
  /** Folder id the node goes in (null = the root). */
  parentId: string | null;
  /** Folders to create, in order, root first. */
  create: { id: string; node: BucketNode }[];
}

/**
 * Plan the parents of `path` from what readParents found. Pure: no writes yet,
 * so the caller can still refuse (node limit, a conflict) before writing.
 */
export function planParents(
  ctx: Pick<ServerCtx, 'ids' | 'now' | 'actor'>,
  path: string,
  found: (Found | null)[],
): ParentPlan {
  const segs = splitBucketPath(path) ?? [];
  let parentId: string | null = null;
  const create: ParentPlan['create'] = [];
  found.forEach((f, i) => {
    const p = segs.slice(0, i + 1).join('/');
    if (f) {
      if (f.node.kind !== 'folder')
        throw errors.conflict(`${p} is a file, not a folder`, { path: p });
      parentId = f.id;
      return;
    }
    const id = ctx.ids.id();
    create.push({ id, node: folderNode(ctx.actor, ctx.now, parentId, segs[i]!, p) });
    parentId = id;
  });
  return { parentId, create };
}

export const folderNode = (
  by: PrincipalId,
  now: number,
  parentId: string | null,
  name: string,
  path: string,
): BucketNode => ({
  kind: 'folder',
  parentId,
  name,
  path,
  file: null,
  createdAt: now,
  createdBy: by,
  updatedAt: now,
  updatedBy: by,
});

/** Refuse when `adding` more nodes would pass BUCKET_NODES_MAX. */
export function assertRoom(bucket: Pick<Bucket, 'stats'>, adding: number): void {
  if (adding <= 0) return;
  const now = bucket.stats.files + bucket.stats.folders;
  if (now + adding > BUCKET_NODES_MAX)
    throw errors.conflict(
      `A bucket holds at most ${BUCKET_NODES_MAX.toLocaleString('en')} files and folders`,
    );
}

/** Write the planned folders. */
export function writeParents(tx: Tx, bucketId: string, plan: ParentPlan): void {
  for (const f of plan.create) tx.create(nodeRef(bucketId, f.id), f.node);
}

/** Bump the bucket's counters (and updatedAt) in the same transaction / batch. */
export function bumpStats(
  w: {
    update: (ref: DocumentReference, data: Record<string, unknown>) => unknown;
  },
  bucketId: string,
  d: { files?: number; folders?: number; bytes?: number },
  now: number,
): void {
  const patch: Record<string, unknown> = { updatedAt: now };
  if (d.files) patch['stats.files'] = FieldValue.increment(d.files);
  if (d.folders) patch['stats.folders'] = FieldValue.increment(d.folders);
  if (d.bytes) patch['stats.bytes'] = FieldValue.increment(d.bytes);
  w.update(rawBucketRef(bucketId), patch);
}

export { bucketParentPath };

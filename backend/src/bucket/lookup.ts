/**
 * One node by id or by path, WHATEVER the bucket's storage (§K): Firestore for
 * a managed bucket, Drive itself for a Drive bucket. For the callers outside
 * the bucket commands — ticket references (refs.ts), the file door
 * (fileAccess.ts), a ticket file's object (uploads.ts).
 */
import type { Bucket, BucketNode } from '@tm/shared';
import { driveAt, driveById, isDriveBucket, openDrive } from './drive/store.js';
import { nodeAt, type Found } from './nodes.js';
import { bucketRef, nodeRef } from './shared.js';

/** The node with this id; null when gone (or, in Drive, moved out of the bucket's folder / trashed). */
export async function nodeById(
  bucketId: string,
  nodeId: string,
  bucket?: Bucket,
): Promise<BucketNode | null> {
  const b = bucket ?? (await bucketRef(bucketId).get()).data();
  if (!b) return null;
  if (isDriveBucket(b))
    return (await driveById(await openDrive(bucketId, b), nodeId))?.node ?? null;
  return (await nodeRef(bucketId, nodeId).get()).data() ?? null;
}

/** The node at a (clean) path, or null. */
export async function nodeByPath(
  bucketId: string,
  path: string,
  bucket?: Bucket,
): Promise<Found | null> {
  const b = bucket ?? (await bucketRef(bucketId).get()).data();
  if (!b) return null;
  if (isDriveBucket(b)) return driveAt(await openDrive(bucketId, b), path);
  return nodeAt(bucketId, path);
}

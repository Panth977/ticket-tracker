/**
 * Delete a bucket for good (bucket.html §G): every version in Storage, every
 * node, then the document — last, so a job that fails halfway is retried
 * against a document that still exists (and is already unreachable:
 * bucketDelete emptied its access in the same write that queued this).
 */
import { bucketStoragePrefix } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { db } from '../runtime/firebase.js';
import { bucketRef, nodesPath } from './shared.js';

export async function purgeBucket(bucketId: string): Promise<void> {
  await ports().files.deletePrefix(bucketStoragePrefix(bucketId));
  await db().recursiveDelete(db().collection(nodesPath(bucketId)));
  await bucketRef(bucketId).delete();
}

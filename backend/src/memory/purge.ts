/**
 * Delete a memory for good (memory.html §G): every version in Storage, every
 * node, then the document — last, so a job that fails halfway is retried
 * against a document that still exists (and is already unreachable:
 * memoryDelete emptied its access in the same write that queued this).
 */
import { memoryStoragePrefix } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { db } from '../runtime/firebase.js';
import { memoryRef, nodesPath } from './shared.js';

export async function purgeMemory(memoryId: string): Promise<void> {
  await ports().files.deletePrefix(memoryStoragePrefix(memoryId));
  await db().recursiveDelete(db().collection(nodesPath(memoryId)));
  await memoryRef(memoryId).delete();
}

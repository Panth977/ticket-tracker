/**
 * Board events → the backend artifacts that asked for them. The query runs on every
 * event, so its answer is cached per board for a minute: a burst of ticket writes
 * costs one read, and a new subscriber is heard within a minute.
 */
import type { Artifact } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { db } from '../runtime/firebase.js';
import { defineTask } from '../runtime/functions.js';
import { gatewayCall, gatewayConfigured } from './gateway.js';

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; rows: { id: string; events: string[] }[] }>();

async function listeners(boardId: string): Promise<{ id: string; events: string[] }[]> {
  const hit = cache.get(boardId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const snap = await db().collection('artifacts').where('backendBoards', 'array-contains', boardId).get();
  const rows = snap.docs
    .map((d) => ({ id: d.id, events: (d.data() as Artifact).backend?.events ?? [] }))
    .filter((r) => r.events.length > 0);
  cache.set(boardId, { at: Date.now(), rows });
  return rows;
}

export function forgetBackendListeners(): void {
  cache.clear();
}

/** Never throws: an event must not fail the change that caused it. */
export async function fanOutToArtifacts(boardId: string, event: string, data: unknown): Promise<void> {
  if (!gatewayConfigured()) return;
  try {
    for (const a of await listeners(boardId)) {
      if (a.events.includes(event) || a.events.includes('*')) {
        await ports().queue.enqueue('artifactEvent', { artifactId: a.id, boardId, event, data });
      }
    }
  } catch (e) {
    console.warn('artifact event fan-out failed', e);
  }
}

defineTask('artifactEvent', async (task) => {
  await gatewayCall('event', task, 60_000);
});

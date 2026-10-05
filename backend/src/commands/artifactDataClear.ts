/**
 * artifactDataClear — the owner's "Delete all data" (Data tab, §F): every
 * document under the artifact's Firestore prefix, every viewer's kv, its RTDB
 * node and its uploaded files. Builds and people are untouched.
 *
 * Queued, like a delete: the data can be any size. The task name carries the
 * request time, so clearing twice is two clears (a second one right after the
 * first must not be dropped as a duplicate of a job that has already run).
 */
import { loadArtifact } from '../artifacts/shared.js';
import { ports } from '../adapters/index.js';
import { defineCommand } from './_registry.js';

export default defineCommand('artifactDataClear', async (ctx, { artifactId }) => {
  await loadArtifact(null, artifactId, ctx, 'manage');
  await ports().queue.enqueue(
    'artifactDelete',
    { artifactId, actor: ctx.actor, dataOnly: true },
    { name: `artifactClear-${artifactId}-${ctx.now}` },
  );
  return { ok: true as const };
});

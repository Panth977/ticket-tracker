/**
 * bucketDelete (bucket.html §G) — owner only. Like artifactDelete: ONE write
 * that makes it unreachable at once (access, grants and memberUids emptied,
 * deletingAt stamped — bucketReach answers null from then on), then the
 * queued job (commands/bucketDeleteJob.ts) removes the files, the nodes and
 * the document last. Tickets pointing at its files keep rows that read as gone.
 * Boards that used it as their attachment bucket (§J) lose that default in
 * the same write.
 */
import { ports } from '../adapters/index.js';
import { loadBucket, bucketRef } from '../bucket/shared.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { boardRef } from './boardShared.js';

export default defineCommand('bucketDelete', async (ctx, { bucketId }) => {
  await runTx(async (tx) => {
    const { bucket } = await loadBucket(tx, bucketId, ctx, 'manage');
    // §J: every board that files its attachments here stops doing so.
    const granted = Object.keys(bucket.boards ?? {});
    const boards = await Promise.all(granted.map((id) => txGet(tx, boardRef(id))));
    granted.forEach((id, i) => {
      if (boards[i]?.attachBucket?.bucketId === bucketId)
        tx.update(boardRef(id), { attachBucket: null, updatedAt: ctx.now });
    });
    tx.update(bucketRef(bucketId), {
      access: {},
      memberUids: [],
      boards: {},
      boardIds: [],
      artifacts: {},
      archivedAt: bucket.archivedAt ?? ctx.now,
      deletingAt: ctx.now,
      updatedAt: ctx.now,
    });
  });
  await ports().queue.enqueue(
    'bucketDelete',
    { bucketId, actor: ctx.ownerUid ?? ctx.actor },
    { name: `bucketDelete-${bucketId}` },
  );
  return { ok: true as const };
});

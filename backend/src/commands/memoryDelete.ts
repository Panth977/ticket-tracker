/**
 * memoryDelete (memory.html §G) — owner only. Like artifactDelete: ONE write
 * that makes it unreachable at once (access, grants and memberUids emptied,
 * deletingAt stamped — memoryReach answers null from then on), then the
 * queued job (commands/memoryDeleteJob.ts) removes the files, the nodes and
 * the document last. Tickets pointing at its files keep rows that read as gone.
 */
import { ports } from '../adapters/index.js';
import { loadMemory, memoryRef } from '../memory/shared.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

export default defineCommand('memoryDelete', async (ctx, { memoryId }) => {
  await runTx(async (tx) => {
    const { memory } = await loadMemory(tx, memoryId, ctx, 'manage');
    tx.update(memoryRef(memoryId), {
      access: {},
      memberUids: [],
      boards: {},
      boardIds: [],
      artifacts: {},
      archivedAt: memory.archivedAt ?? ctx.now,
      deletingAt: ctx.now,
      updatedAt: ctx.now,
    });
  });
  await ports().queue.enqueue(
    'memoryDelete',
    { memoryId, actor: ctx.ownerUid ?? ctx.actor },
    { name: `memoryDelete-${memoryId}` },
  );
  return { ok: true as const };
});

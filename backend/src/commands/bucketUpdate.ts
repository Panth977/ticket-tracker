/** bucketUpdate (bucket.html §A) — owner only: name, description, indicator, archive / restore. */
import type { Bucket } from '@tm/shared';
import { loadBucket, bucketRef } from '../bucket/shared.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { markPatch } from './indicatorShared.js';

export default defineCommand('bucketUpdate', async (ctx, input) => {
  await runTx(async (tx) => {
    const { bucket } = await loadBucket(tx, input.bucketId, ctx, 'manage');
    const patch: Partial<Bucket> = {};
    if (input.name !== undefined && input.name !== bucket.name) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description || null;
    Object.assign(patch, markPatch(input));
    if (input.archived !== undefined && input.archived !== (bucket.archivedAt !== null))
      patch.archivedAt = input.archived ? ctx.now : null;
    if (Object.keys(patch).length === 0) return;
    patch.updatedAt = ctx.now;
    tx.update(bucketRef(input.bucketId), patch);
  });
  return { ok: true as const };
});

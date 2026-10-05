/** memoryUpdate (memory.html §A) — owner only: name, description, emoji, archive / restore. */
import type { Memory } from '@tm/shared';
import { loadMemory, memoryRef } from '../memory/shared.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

export default defineCommand('memoryUpdate', async (ctx, input) => {
  await runTx(async (tx) => {
    const { memory } = await loadMemory(tx, input.memoryId, ctx, 'manage');
    const patch: Partial<Memory> = {};
    if (input.name !== undefined && input.name !== memory.name) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description || null;
    if (input.icon !== undefined) patch.icon = input.icon || null;
    if (input.archived !== undefined && input.archived !== (memory.archivedAt !== null))
      patch.archivedAt = input.archived ? ctx.now : null;
    if (Object.keys(patch).length === 0) return;
    patch.updatedAt = ctx.now;
    tx.update(memoryRef(input.memoryId), patch);
  });
  return { ok: true as const };
});

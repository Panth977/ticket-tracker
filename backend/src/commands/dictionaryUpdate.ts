/** dictionaryUpdate (dictionary.html §C) — owner only: name, description, indicator, archive / restore. */
import type { Dictionary } from '@tm/shared';
import { dictionaryRef, loadDictionary } from '../dictionary/shared.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

export default defineCommand('dictionaryUpdate', async (ctx, input) => {
  await runTx(async (tx) => {
    const { dictionary: d } = await loadDictionary(tx, input.dictionaryId, ctx, 'manage');
    const patch: Partial<Dictionary> = {};
    if (input.name !== undefined && input.name !== d.name) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description || null;
    if (input.indicator) patch.indicator = input.indicator;
    if (input.archived !== undefined && input.archived !== (d.archivedAt !== null))
      patch.archivedAt = input.archived ? ctx.now : null;
    if (Object.keys(patch).length === 0) return;
    patch.updatedAt = ctx.now;
    tx.update(dictionaryRef(input.dictionaryId), patch);
  });
  return { ok: true as const };
});

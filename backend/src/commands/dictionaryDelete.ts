/**
 * dictionaryDelete (dictionary.html §C) — owner only. The entries and the
 * document go in one transaction: there are no files to clean up after.
 */
import { contentRef, dictionaryRef, loadDictionary } from '../dictionary/shared.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

export default defineCommand('dictionaryDelete', async (ctx, { dictionaryId }) => {
  await runTx(async (tx) => {
    await loadDictionary(tx, dictionaryId, ctx, 'manage');
    tx.delete(contentRef(dictionaryId));
    tx.delete(dictionaryRef(dictionaryId));
  });
  return { ok: true as const };
});

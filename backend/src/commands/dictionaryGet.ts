/** dictionaryGet (dictionary.html §C) — read reach: every entry, in order. */
import { loadDictionary, readEntries, toDictionaryOut } from '../dictionary/shared.js';
import { defineCommand } from './_registry.js';

export default defineCommand('dictionaryGet', async (ctx, { dictionaryId, keys }) => {
  const { dictionary, reach } = await loadDictionary(null, dictionaryId, ctx, 'read');
  const { entries, updatedAt } = await readEntries(dictionaryId);
  const want = keys ? new Set(keys) : null;
  return {
    dictionary: toDictionaryOut(dictionaryId, dictionary, reach),
    entries: want ? entries.filter((e) => want.has(e.key)) : entries,
    entriesUpdatedAt: updatedAt,
  };
});

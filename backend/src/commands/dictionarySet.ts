/**
 * dictionarySet (dictionary.html §C) — change entries: `set` some (null
 * removes; a new key goes at the end, a known one keeps its place), or
 * `replace` them all. Limits (entries, bytes) are checked on the result.
 */
import { entriesIn, errors, type DictionaryEntry } from '@tm/shared';
import {
  contentRef,
  dictionaryRef,
  loadDictionary,
  readEntries,
  toDictionaryOut,
} from '../dictionary/shared.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

export default defineCommand('dictionarySet', async (ctx, input) => {
  const res = await runTx(async (tx) => {
    const { dictionary, reach } = await loadDictionary(tx, input.dictionaryId, ctx, 'write');
    const cur = await readEntries(input.dictionaryId, tx);
    if (
      input.expectedUpdatedAt !== undefined &&
      (input.expectedUpdatedAt ?? null) !== cur.updatedAt
    )
      throw errors.conflict('The entries changed since you read them — reload and try again');
    let next: DictionaryEntry[];
    if (input.replace) next = input.replace.map((e) => ({ key: e.key, value: e.value }));
    else {
      next = [...cur.entries];
      for (const [key, value] of Object.entries(input.set ?? {})) {
        const i = next.findIndex((e) => e.key === key);
        if (value === null) {
          if (i >= 0) next.splice(i, 1);
        } else if (i >= 0) next[i] = { key, value };
        else next.push({ key, value });
      }
    }
    let stored: ReturnType<typeof entriesIn>;
    try {
      stored = entriesIn(next);
    } catch (e) {
      throw errors.invalid((e as Error).message);
    }
    tx.set(contentRef(input.dictionaryId), {
      entries: stored.entries,
      updatedAt: ctx.now,
      updatedBy: ctx.actor,
    });
    const stats = { entries: stored.entries.length, bytes: stored.bytes };
    tx.update(dictionaryRef(input.dictionaryId), { stats, updatedAt: ctx.now });
    return {
      dictionary: toDictionaryOut(
        input.dictionaryId,
        { ...dictionary, stats, updatedAt: ctx.now },
        reach,
      ),
      entries: next,
      entriesUpdatedAt: ctx.now,
    };
  });
  return res;
});

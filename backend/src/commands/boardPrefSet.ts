/**
 * boardPrefSet — can(read); ALWAYS the caller's own prefs/{actor}. There is
 * no uid parameter: nobody sets another person's notification choices.
 * A partial pref is merged over the stored one (or the defaults).
 */
import { errors, paths, type BoardPref } from '@tm/shared';
import { typedDoc } from '../runtime/converters.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { loadBoard } from './boardShared.js';

export default defineCommand('boardPrefSet', async (ctx, { boardId, pref }) => {
  await runTx(async (tx) => {
    const board = await loadBoard(tx, boardId, ctx, 'read');
    const ref = typedDoc('prefs', paths.pref(boardId, ctx.actor));
    const current: BoardPref = (await txGet(tx, ref)) ?? {
      mode: 'mine',
      watching: [],
      starred: false,
      lastViewId: board.defaultViewId,
    };
    if (pref.lastViewId !== undefined && pref.lastViewId !== current.lastViewId) {
      const v = await txGet(tx, typedDoc('views', paths.view(boardId, pref.lastViewId)));
      if (!v || (v.scope === 'personal' && v.ownerUid !== ctx.actor))
        throw errors.not_found('View not found');
    }
    if (pref.stageIds) {
      const known = new Set(board.stages.map((s) => s.id));
      const bad = pref.stageIds.filter((s) => !known.has(s));
      if (bad.length) throw errors.invalid('Unknown stage ids', { stageIds: bad });
    }
    const next: BoardPref = { ...current, ...pref };
    // `events` / `stageIds` absent = every event / every stage: allow clearing by sending [].
    tx.set(ref, next);
  });
  return { ok: true as const };
});

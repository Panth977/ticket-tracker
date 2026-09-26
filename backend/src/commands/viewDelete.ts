/**
 * viewDelete — personal → its owner; shared → can(edit).
 * The board's default view cannot be deleted (409: choose another default
 * first). Prefs whose lastViewId pointed at it fall back to the default.
 */
import { errors, paths } from '@tm/shared';
import { can } from '@tm/shared/logic/index';
import { typedCol, typedDoc } from '../runtime/converters.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { inBatches, loadBoard } from './boardShared.js';

export default defineCommand('viewDelete', async (ctx, { boardId, viewId }) => {
  const defaultViewId = await runTx(async (tx) => {
    const board = await loadBoard(tx, boardId, ctx, 'read');
    const ref = typedDoc('views', paths.view(boardId, viewId));
    const view = await txGet(tx, ref);
    if (!view || (view.scope === 'personal' && view.ownerUid !== ctx.actor))
      throw errors.not_found('View not found');
    if (view.scope === 'shared' && !can(ctx, board, 'edit'))
      throw errors.forbidden('Only editors can delete shared views');
    if (viewId === board.defaultViewId)
      throw errors.conflict(
        "The board's default view cannot be deleted — choose another default first",
      );
    tx.delete(ref);
    return board.defaultViewId;
  });

  const stale = await typedCol('prefs', paths.prefs(boardId))
    .where('lastViewId', '==', viewId)
    .get();
  await inBatches(stale.docs, (b, d) => b.update(d.ref, { lastViewId: defaultViewId }));
  return { ok: true as const };
});

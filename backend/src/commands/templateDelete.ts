/**
 * templateDelete — admins (docs/plan/templates.html §A). A kanban view whose
 * cards used it goes back to the built-in card (cardTemplateId → null), in
 * the same transaction, so no view ever names a template that is gone.
 */
import { errors, paths } from '@tm/shared';
import { typedCol, typedDoc } from '../runtime/converters.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { loadBoard } from './boardShared.js';

export default defineCommand('templateDelete', async (ctx, { boardId, templateId }) => {
  // Views are few per board (and read again below); the query sits outside the tx.
  const using = await typedCol('views', paths.views(boardId))
    .where('cardTemplateId', '==', templateId)
    .get();
  await runTx(async (tx) => {
    await loadBoard(tx, boardId, ctx, 'admin');
    const ref = typedDoc('templates', paths.template(boardId, templateId));
    if (!(await txGet(tx, ref))) throw errors.not_found('Template not found');
    tx.delete(ref);
    for (const v of using.docs) tx.update(v.ref, { cardTemplateId: null });
  });
  return { ok: true as const };
});

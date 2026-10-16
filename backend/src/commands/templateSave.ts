/**
 * templateSave — create or update one of a board's templates
 * (docs/plan/templates.html §A). Admins only: a template is code that runs in
 * the browser of everyone who opens the composer, the New ticket dialog or a
 * kanban view using it — sandboxed (§B), but still the board's to decide.
 *
 *   new      → an id, the next position, createdBy / createdAt
 *   update   → same kind (a card template cannot become a form: views name it)
 *   ≤ TEMPLATES_MAX per board
 */
import { errors, paths, TEMPLATES_MAX, type Template } from '@tm/shared';
import { typedCol, typedDoc } from '../runtime/converters.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { loadBoard } from './boardShared.js';

export default defineCommand('templateSave', async (ctx, input) => {
  const { boardId, template: t } = input;
  const templateId = input.templateId ?? ctx.ids.id();

  // Count outside the transaction (a query); a race past the cap by one is harmless.
  const count = input.templateId
    ? 0
    : (await typedCol('templates', paths.templates(boardId)).get()).size;

  await runTx(async (tx) => {
    const board = await loadBoard(tx, boardId, ctx, 'admin');
    if (board.archivedAt != null) throw errors.conflict('This board is archived');
    const ref = typedDoc('templates', paths.template(boardId, templateId));
    const existing = input.templateId ? await txGet(tx, ref) : undefined;
    if (input.templateId && !existing) throw errors.not_found('Template not found');
    if (existing && existing.kind !== t.kind)
      throw errors.conflict(`A ${existing.kind} template stays a ${existing.kind} template`, {
        kind: existing.kind,
      });
    if (!existing && count >= TEMPLATES_MAX)
      throw errors.conflict(`A board holds at most ${TEMPLATES_MAX} templates`);

    const doc: Template = {
      kind: t.kind,
      name: t.name,
      description: t.description !== undefined ? t.description : (existing?.description ?? null),
      ...(t.indicator
        ? { indicator: t.indicator }
        : existing?.indicator
          ? { indicator: existing.indicator }
          : {}),
      code: t.code,
      position: t.position ?? existing?.position ?? ctx.now,
      createdBy: existing?.createdBy ?? ctx.actor,
      createdAt: existing?.createdAt ?? ctx.now,
      updatedBy: ctx.actor,
      updatedAt: ctx.now,
    };
    tx.set(ref, doc);
  });

  return { templateId };
});

/**
 * viewSave — create or update a saved view.
 *
 *   personal → can(read) (and, when updating, only its owner)
 *   shared   → can(edit); promoting a personal view to shared needs edit too
 *
 * Every field a view names (filter leaves, sort, group, columns, dates,
 * card fields) must exist on the board: a view naming a deleted field would
 * silently match nothing. Archived fields still exist (values are kept).
 */
import { errors, isFilterGroup, paths, type Board, type FilterNode, type View } from '@tm/shared';
import { can } from '@tm/shared/logic/index';
import { typedDoc } from '../runtime/converters.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { loadBoard } from './boardShared.js';

/** Every `fields.f_xxxxxx` a view references. */
export function viewFieldRefs(view: Omit<View, 'ownerUid'>): string[] {
  const out = new Set<string>();
  const add = (f: string | null | undefined) => {
    if (f && f.startsWith('fields.')) out.add(f.slice('fields.'.length));
  };
  const walk = (n: FilterNode | null) => {
    if (!n) return;
    if (isFilterGroup(n)) n.children.forEach(walk);
    else add(n.field);
  };
  walk(view.filter);
  view.sort.forEach((s) => add(s.field));
  add(view.groupBy);
  add(view.subGroupBy);
  add(view.dateField);
  add(view.endDateField);
  view.columns.forEach((c) => add(c.field));
  view.cardFields.forEach(add);
  return [...out];
}

export function assertViewFields(board: Pick<Board, 'fields'>, view: Omit<View, 'ownerUid'>): void {
  const known = new Set(board.fields.map((f) => f.id));
  const missing = viewFieldRefs(view).filter((id) => !known.has(id));
  if (missing.length)
    throw errors.invalid('The view names fields that are not on this board', {
      fields: missing.map((m) => `fields.${m}`),
    });
}

export default defineCommand('viewSave', async (ctx, input) => {
  const { boardId, view } = input;
  const viewId = input.viewId ?? ctx.ids.id();

  await runTx(async (tx) => {
    const board = await loadBoard(tx, boardId, ctx, 'read');
    const ref = typedDoc('views', paths.view(boardId, viewId));
    const existing = input.viewId ? await txGet(tx, ref) : undefined;
    if (input.viewId && !existing) throw errors.not_found('View not found');
    // Someone else's personal view is invisible to you.
    if (existing?.scope === 'personal' && existing.ownerUid !== ctx.actor)
      throw errors.not_found('View not found');

    const needsEdit = view.scope === 'shared' || existing?.scope === 'shared';
    if (needsEdit && !can(ctx, board, 'edit'))
      throw errors.forbidden('Only editors can save shared views');
    // The board's default view must stay shared (everyone lands on it).
    if (existing && viewId === board.defaultViewId && view.scope !== 'shared')
      throw errors.conflict("The board's default view must stay shared");

    assertViewFields(board, view);
    // ownerUid is the actor for new views and personal ones; a shared view keeps its author.
    const ownerUid =
      existing && existing.scope === 'shared' && view.scope === 'shared'
        ? existing.ownerUid
        : ctx.actor;
    tx.set(ref, { ...view, ownerUid });
  });

  return { viewId };
});

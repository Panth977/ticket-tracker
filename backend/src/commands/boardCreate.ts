/**
 * boardCreate — ANY signed-in user may create a board (10 per person per day).
 *
 * One transaction: claim boardKeys/{key} (a second create of the same id is
 * the uniqueness → 409), create the board from its template with the creator
 * as its only admin, their members/ row, their prefs/, and the default views.
 * After commit: the RTDB boardReaders mirror.
 *
 * { fromBoardId } copies stages, priorities, tags, fields, settings and the
 * SHARED views of a board the caller can read — never its people, tickets or
 * anyone's personal views.
 */
import { errors, isAgentId, paths, type Board, type BoardPref, type View } from '@tm/shared';
import { rateBuckets } from '@tm/shared';
import { can } from '@tm/shared/logic/index';
import { typedCol, typedDoc } from '../runtime/converters.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import {
  BOARD_CREATES_PER_DAY,
  boardRef,
  deriveAccess,
  memberDoc,
  memberRef,
  profileOf,
  syncReaders,
  takeRate,
} from './boardShared.js';
import { defaultViews, seedFor, type BoardSeed } from './boardTemplates.js';

export default defineCommand('boardCreate', async (ctx, input) => {
  // §AA1/§AA2: a board is created by a person (the creator becomes its admin
  // and its first reader — an agent can be neither a reader nor an owner).
  // An agent token has no boards:create scope; this says so by name as well.
  if (isAgentId(ctx.actor)) throw errors.forbidden('Agents cannot create boards');
  const template = input.template ?? 'blank';
  const boardId = ctx.ids.id();

  // Copy-a-board: read the source first (outside the tx — it is not modified).
  let seed: BoardSeed;
  let copiedViews: { key: string; view: View; wasDefault: boolean }[] | null = null;
  if (typeof template === 'object') {
    const src = await boardRef(template.fromBoardId).get();
    const data = src.exists ? src.data()! : undefined;
    if (!data || !can(ctx, { ...data, id: src.id }, 'read'))
      throw errors.not_found('Board to copy not found');
    seed = {
      stages: data.stages,
      priorities: data.priorities,
      tags: data.tags,
      fields: data.fields,
      settings: data.settings,
    };
    const views = await typedCol('views', paths.views(src.id)).where('scope', '==', 'shared').get();
    copiedViews = views.docs.map((d) => ({
      key: d.id,
      view: { ...d.data(), ownerUid: ctx.actor },
      wasDefault: d.id === data.defaultViewId,
    }));
  } else {
    seed = seedFor(template, ctx.ids);
  }

  const views =
    (copiedViews?.length ? copiedViews : null) ??
    defaultViews(ctx.actor, seed.fields).map((v, i) => ({ ...v, wasDefault: i === 0 }));
  const viewIds = views.map(() => ctx.ids.id());
  const defaultViewId =
    viewIds[
      Math.max(
        0,
        views.findIndex((v) => v.wasDefault),
      )
    ]!;

  const profile = await profileOf(ctx.actor);
  const refund = await takeRate(
    rateBuckets.boardCreates(ctx.actor),
    BOARD_CREATES_PER_DAY,
    ctx.now,
  );

  const access = { [ctx.actor]: 'admin' as const };
  const board: Board = {
    name: input.name,
    key: input.key,
    nextNumber: 1,
    color: input.color ?? 'blue',
    icon: input.icon ?? '',
    description: null,
    access,
    stageGrants: {},
    ...deriveAccess(access),
    stages: seed.stages,
    priorities: seed.priorities,
    tags: seed.tags,
    fields: seed.fields,
    defaultViewId,
    settings: seed.settings,
    counts: { active: 0, done: 0, overdue: 0 },
    archivedAt: null,
    createdBy: ctx.actor,
    createdAt: ctx.now,
  };
  const pref: BoardPref = { mode: 'mine', watching: [], starred: false, lastViewId: defaultViewId };

  try {
    await runTx(async (tx) => {
      const keyRef = typedDoc('boardKeys', paths.boardKey(input.key));
      if (await txGet(tx, keyRef))
        throw errors.conflict(`The key ${input.key} is taken`, { key: input.key });
      tx.create(keyRef, { boardId, claimedAt: ctx.now });
      tx.create(boardRef(boardId), board);
      tx.create(
        memberRef(boardId, ctx.actor),
        memberDoc(ctx.actor, 'admin', profile, null, ctx.now),
      );
      tx.set(typedDoc('prefs', paths.pref(boardId, ctx.actor)), pref);
      views.forEach(({ view }, i) =>
        tx.set(typedDoc('views', paths.view(boardId, viewIds[i]!)), view),
      );
    });
  } catch (e) {
    await refund();
    throw e;
  }

  await syncReaders(boardId, board.readerUids);
  return { boardId };
});

/**
 * boardUpdate — can(admin). PATCHES ARE PER SECTION: each settings section
 * saves itself, so two admins saving different sections never clobber each
 * other (the reference PATCHed one wholesale blob).
 *
 *   stages      a removed stage that still has tickets needs remap.stages[old] = new,
 *               else 409 { stageId, count }. A stage whose CATEGORY changed →
 *               stageCategory (and completedAt) rewritten on its tickets.
 *   priorities  same rule: 409 { priorityId, count } without remap.priorities.
 *   tags        a removed tag is pulled from its tickets.
 *   fields      a field missing from the new list is ARCHIVED, never deleted —
 *               values stay on tickets. A field's type never changes.
 *   settings    merged key by key.
 *
 * The board document commits in one transaction; the ticket rewrites (which
 * can be more than a transaction holds) run in batches right after.
 */
import {
  errors,
  paths,
  type Activity,
  type Board,
  type BoardWithId,
  type CommandReqParsed,
  type FieldDef,
  type Option,
  type Stage,
  type StageGrant,
  type Ticket,
} from '@tm/shared';
import { parseRichText } from '@tm/shared/logic/index';
import type { DocumentReference } from 'firebase-admin/firestore';
import type { ServerCtx } from '../runtime/context.js';
import { typedDoc } from '../runtime/converters.js';
import { db } from '../runtime/firebase.js';
import { runTx, txGet } from '../runtime/tx.js';
import { batchWriter } from '../tickets/doc.js';
import { defineCommand } from './_registry.js';
import {
  allDocs,
  assertActive,
  boardRef,
  inBatches,
  loadBoard,
  loadBoardNoTx,
} from './boardShared.js';

type Input = CommandReqParsed<'boardUpdate'>;

interface Plan {
  update: Record<string, unknown>;
  /** old stage id → new stage id */
  stageMoves: Map<string, string>;
  /** removed stages with no remap — must be empty of tickets */
  stagesMustBeEmpty: string[];
  /** stage id → new category (for stages that stay but changed category) */
  categoryChanges: Map<string, Stage['category']>;
  priorityMoves: Map<string, string>;
  prioritiesMustBeEmpty: string[];
  removedTags: string[];
  newStages: Stage[] | null;
}

function uniqueIds(list: { id: string }[], what: string): void {
  const seen = new Set<string>();
  for (const x of list) {
    if (seen.has(x.id)) throw errors.invalid(`Duplicate ${what} id "${x.id}"`);
    seen.add(x.id);
  }
}

/** Pure: validate the patch against the board and work out every consequence. */
export function planUpdate(board: Board, { patch, remap }: Pick<Input, 'patch' | 'remap'>): Plan {
  const plan: Plan = {
    update: {},
    stageMoves: new Map(),
    stagesMustBeEmpty: [],
    categoryChanges: new Map(),
    priorityMoves: new Map(),
    prioritiesMustBeEmpty: [],
    removedTags: [],
    newStages: null,
  };
  const u = plan.update;
  if (patch.name !== undefined) u.name = patch.name;
  if (patch.color !== undefined) u.color = patch.color;
  if (patch.icon !== undefined) u.icon = patch.icon;
  if (patch.description !== undefined)
    u.description = patch.description === null ? null : parseRichText(patch.description);

  // fields first: stage `requires` are checked against the resulting list.
  let fields: FieldDef[] = board.fields;
  if (patch.fields) {
    uniqueIds(patch.fields, 'field');
    const old = new Map(board.fields.map((f) => [f.id, f]));
    for (const f of patch.fields) {
      const prev = old.get(f.id);
      if (prev && prev.type !== f.type)
        throw errors.invalid(`Field "${prev.name}" cannot change type (${prev.type} → ${f.type})`, {
          fieldId: f.id,
        });
    }
    const kept = new Set(patch.fields.map((f) => f.id));
    const archived = board.fields
      .filter((f) => !kept.has(f.id))
      .map((f) => ({ ...f, archived: true }));
    fields = [...patch.fields, ...archived];
    u.fields = fields;
  }

  if (patch.stages) {
    const next = patch.stages;
    uniqueIds(next, 'stage');
    const fieldIds = new Set(fields.map((f) => f.id));
    for (const s of next) {
      const bad = (s.requires ?? []).filter((r) => !fieldIds.has(r));
      if (bad.length)
        throw errors.invalid(`Stage "${s.name}" requires unknown fields`, { fields: bad });
    }
    const nextById = new Map(next.map((s) => [s.id, s]));
    const moves = remap?.stages ?? {};
    for (const old of board.stages) {
      const now = nextById.get(old.id);
      if (now) {
        if (now.category !== old.category) plan.categoryChanges.set(old.id, now.category);
        continue;
      }
      const to = moves[old.id];
      if (to === undefined) plan.stagesMustBeEmpty.push(old.id);
      else if (!nextById.has(to))
        throw errors.invalid(`remap.stages: "${to}" is not a stage in the new list`);
      else plan.stageMoves.set(old.id, to);
    }
    for (const k of Object.keys(moves))
      if (!board.stages.some((s) => s.id === k) || nextById.has(k))
        throw errors.invalid(`remap.stages: "${k}" is not a removed stage`);
    u.stages = next;
    plan.newStages = next;
    // Stage grants may only name stages that exist.
    const grants: Record<string, StageGrant> = {};
    let changed = false;
    for (const [uid, g] of Object.entries(board.stageGrants)) {
      const stages = g.stages.filter((s) => nextById.has(s));
      if (stages.length !== g.stages.length) changed = true;
      grants[uid] = { ...g, stages };
    }
    if (changed) u.stageGrants = grants;
  }

  if (patch.priorities) {
    uniqueIds(patch.priorities, 'priority');
    const nextIds = new Set(patch.priorities.map((p) => p.id));
    const moves = remap?.priorities ?? {};
    for (const old of board.priorities) {
      if (nextIds.has(old.id)) continue;
      const to = moves[old.id];
      if (to === undefined) plan.prioritiesMustBeEmpty.push(old.id);
      else if (!nextIds.has(to))
        throw errors.invalid(`remap.priorities: "${to}" is not a priority in the new list`);
      else plan.priorityMoves.set(old.id, to);
    }
    for (const k of Object.keys(moves))
      if (!board.priorities.some((p) => p.id === k) || nextIds.has(k))
        throw errors.invalid(`remap.priorities: "${k}" is not a removed priority`);
    u.priorities = patch.priorities;
  } else if (remap?.priorities && Object.keys(remap.priorities).length) {
    throw errors.invalid('remap.priorities without patch.priorities');
  }
  if (!patch.stages && remap?.stages && Object.keys(remap.stages).length)
    throw errors.invalid('remap.stages without patch.stages');

  if (patch.tags) {
    uniqueIds(patch.tags, 'tag');
    const nextIds = new Set(patch.tags.map((t: Option) => t.id));
    plan.removedTags = board.tags.filter((t) => !nextIds.has(t.id)).map((t) => t.id);
    u.tags = patch.tags;
  }

  if (patch.settings) {
    for (const [k, v] of Object.entries(patch.settings))
      if (v !== undefined) u[`settings.${k}`] = v;
  }
  if (patch.defaultViewId !== undefined) u.defaultViewId = patch.defaultViewId;
  return plan;
}

async function countWhere(boardId: string, field: string, value: string): Promise<number> {
  const snap = await db()
    .collection(paths.tickets(boardId))
    .where(field, '==', value)
    .count()
    .get();
  return snap.data().count;
}

/** A ticket's stage moved (remap) or its stage's category changed. */
function stageChange(t: Ticket, stageId: string, category: Stage['category'], now: number) {
  const out: Record<string, unknown> = {};
  const changes: Activity['changes'] = {};
  if (t.stageId !== stageId) {
    out.stageId = stageId;
    changes.stageId = { from: t.stageId, to: stageId };
  }
  if (t.stageCategory !== category) {
    out.stageCategory = category;
    changes.stageCategory = { from: t.stageCategory, to: category };
    if (category === 'done' && t.stageCategory !== 'done') out.completedAt = now;
    else if (category !== 'done' && t.stageCategory === 'done') out.completedAt = null;
  }
  return { out, changes };
}

async function rewriteTickets(board: BoardWithId, plan: Plan, ctx: ServerCtx): Promise<void> {
  const col = db().collection(paths.tickets(board.id));
  const stages = new Map((plan.newStages ?? board.stages).map((s) => [s.id, s]));
  type W = {
    ref: DocumentReference;
    ticket: Ticket;
    data: Record<string, unknown>;
    changes: Activity['changes'];
  };
  const writes = new Map<string, W>();
  const add = (
    ref: DocumentReference,
    ticket: Ticket,
    data: Record<string, unknown>,
    changes: Activity['changes'],
  ) => {
    const w = writes.get(ref.id) ?? { ref, ticket, data: {}, changes: {} };
    Object.assign(w.data, data);
    Object.assign(w.changes, changes);
    writes.set(ref.id, w);
  };

  const stageTouch = new Map<string, string>(plan.stageMoves);
  for (const s of plan.categoryChanges.keys()) stageTouch.set(s, s);
  for (const [from, to] of stageTouch) {
    const target = stages.get(to)!;
    for (const d of await allDocs(col.where('stageId', '==', from))) {
      const t = d.data() as Ticket;
      const { out, changes } = stageChange(t, to, target.category, ctx.now);
      if (Object.keys(out).length) add(d.ref, t, out, changes);
    }
  }
  for (const [from, to] of plan.priorityMoves) {
    for (const d of await allDocs(col.where('priorityId', '==', from)))
      add(d.ref, d.data() as Ticket, { priorityId: to }, { priorityId: { from, to } });
  }
  for (const tag of plan.removedTags) {
    for (const d of await allDocs(col.where('tagIds', 'array-contains', tag))) {
      const t = d.data() as Ticket;
      const w = writes.get(d.id);
      const before = (w?.data.tagIds as string[] | undefined) ?? t.tagIds;
      const after = before.filter((x) => x !== tag);
      add(d.ref, t, { tagIds: after }, { tagIds: { from: t.tagIds, to: after } });
    }
  }

  await inBatches(
    [...writes.values()],
    (batch, w) => {
      // §W: the ticket and its activity row are the same document — one write.
      const tw = batchWriter(batch, ctx, board.id, w.ref.id, w.ticket);
      tw.set({ ...w.data, updatedAt: ctx.now });
      tw.addActivity({
        action: 'update',
        changes: w.changes,
        actor: ctx.actor,
        via: ctx.via,
        createdAt: ctx.now,
      });
      tw.touch();
      tw.commit();
    },
    400,
  );
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export default defineCommand('boardUpdate', async (ctx, input) => {
  const { boardId } = input;
  const before = await loadBoardNoTx(boardId, ctx, 'admin');
  assertActive(before);
  const pre = planUpdate(before, input);

  // A removed stage / priority still in use needs somewhere to put its tickets.
  for (const stageId of pre.stagesMustBeEmpty) {
    const count = await countWhere(boardId, 'stageId', stageId);
    if (count > 0)
      throw errors.conflict('This stage still has tickets — choose where they go', {
        stageId,
        count,
      });
  }
  for (const priorityId of pre.prioritiesMustBeEmpty) {
    const count = await countWhere(boardId, 'priorityId', priorityId);
    if (count > 0)
      throw errors.conflict('This priority is still in use — choose a replacement', {
        priorityId,
        count,
      });
  }

  const { board, plan } = await runTx(async (tx) => {
    const board = await loadBoard(tx, boardId, ctx, 'admin');
    assertActive(board);
    const plan = planUpdate(board, input);
    // Another admin changed the same section between our count and now: retry, don't guess.
    if (
      !sameIds(plan.stagesMustBeEmpty, pre.stagesMustBeEmpty) ||
      !sameIds(plan.prioritiesMustBeEmpty, pre.prioritiesMustBeEmpty)
    )
      throw errors.conflict('The board changed while saving — reload and try again');
    if (input.patch.defaultViewId !== undefined) {
      const v = await txGet(tx, typedDoc('views', paths.view(boardId, input.patch.defaultViewId)));
      if (!v) throw errors.invalid('defaultViewId: no such view');
      if (v.scope !== 'shared') throw errors.invalid('The default view must be a shared view');
    }
    if (Object.keys(plan.update).length) tx.update(boardRef(boardId), plan.update);
    return { board, plan };
  });

  await rewriteTickets(board, plan, ctx);
  return { ok: true as const };
});

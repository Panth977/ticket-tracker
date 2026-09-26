/**
 * ticketBulk (app/backend.json services.ticketBulk) — the reference's
 * POST_TtBoardTasksBulk.
 *
 * The board and the role are resolved ONCE. Editor+ may run any action; a
 * commenter may only run 'stage', and only over the tickets their grant
 * covers — the rest are SKIPPED and reported, not failed. Tickets that are
 * missing, closed (for non-state actions), or would enter a stage whose
 * `requires` they do not meet are skipped too.
 *
 * Writes are batched (250 tickets = ticket + activity per batch; state
 * changes add a system line, so 150). Notifications: ONE per recipient for
 * the whole run ('Priya moved 14 tickets to Done'), not fourteen; webhooks
 * stay per ticket (receivers sync ticket by ticket).
 */
import { betweenN, can, diff, effectiveRole, type CanCtx } from '@tm/shared/logic/index';
import {
  bulkActionScope,
  errors,
  paths,
  type BulkAction,
  type Ticket,
  type TicketWithId,
} from '@tm/shared';
import { db } from '../runtime/firebase.js';
import { batchWriter } from '../tickets/doc.js';
import { loadBoard, requireCan, requireWritableBoard, withTicketId } from '../tickets/access.js';
import { emitSafe, notifySafe } from '../tickets/effects.js';
import { chunk } from '../tickets/locate.js';
import { applyPatch, updatesFor, type CleanPatch, type Pair } from '../tickets/patch.js';
import { toPublicTicket } from '../platform/public.js';
import { lastRankInStage } from '../tickets/rank.js';
import { stateAction, writeStateChange } from '../tickets/state.js';
import {
  checkFieldValue,
  checkMembers,
  checkPriority,
  checkTags,
  findStage,
  missingForStage,
} from '../tickets/validate.js';
import { activityDoc, actorName } from '../tickets/writes.js';
import { defineCommand } from './_registry.js';

/** One write per ticket now (§W); Firestore's batch limit is 500. */
export const BULK_BATCH_TICKETS = 400;
export const BULK_BATCH_TICKETS_WITH_LINE = BULK_BATCH_TICKETS;

export default defineCommand('ticketBulk', async (ctx, input) => {
  const { boardId, action: a } = input;
  const board = await loadBoard(ctx, boardId);
  requireWritableBoard(board);

  // ── token scope, once: the one scope this action needs (agents.html §E) ──
  if (ctx.scopes) {
    const need = bulkActionScope(a);
    if (!ctx.scopes.includes(need))
      throw errors.forbidden(`This token lacks the "${need}" scope`, { missing: [need] });
  }
  // From here on the ROLE decides (scopes are settled above).
  const rc: CanCtx = { actor: ctx.actor, boardIds: ctx.boardIds ?? null };

  // ── role, once ──
  const editor = can(rc, board, 'edit');
  // Below editor, only a commenter's 'stage' run gets through (ticket by ticket, below).
  if (!editor && (a.type !== 'stage' || effectiveRole(board, ctx.actor) !== 'commenter'))
    requireCan(rc, board, a.type === 'addAssignee' ? 'assign' : 'edit');

  // ── validate the action against the board ──
  let patchFor: (t: Ticket) => CleanPatch;
  switch (a.type) {
    case 'stage': {
      const stage = findStage(board, a.stageId);
      patchFor = () => ({ stageId: stage.id });
      break;
    }
    case 'priority':
      checkPriority(board, a.priorityId);
      patchFor = () => ({ priorityId: a.priorityId });
      break;
    case 'due':
      patchFor = () => ({ dueAt: a.dueAt });
      break;
    case 'addTag':
      checkTags(board, [a.tagId]);
      patchFor = (t) => ({ tagIds: [...new Set([...t.tagIds, a.tagId])] });
      break;
    case 'addAssignee':
      checkMembers(board, [a.uid], 'uid');
      patchFor = (t) => ({ assigneeUids: [...new Set([...t.assigneeUids, a.uid])] });
      break;
    case 'field': {
      const value = checkFieldValue(board, a.fieldId, a.value);
      const def = board.fields.find((f) => f.id === a.fieldId)!;
      if (
        def.required &&
        (value === null || value === '' || (Array.isArray(value) && !value.length))
      )
        throw errors.invalid('Required fields cannot be cleared', { missing: [def.id] });
      patchFor = () => ({ fields: { [a.fieldId]: value } });
      break;
    }
    case 'state':
      patchFor = () => ({ state: a.state });
      break;
  }

  // ── read every ticket once ──
  const ids = [...new Set(input.ticketIds)];
  const tickets = new Map<string, Ticket>();
  for (const part of chunk(ids, 100)) {
    const snaps = await db().getAll(...part.map((id) => db().doc(paths.ticket(boardId, id))));
    for (const s of snaps) if (s.exists) tickets.set(s.id, s.data() as Ticket);
  }

  const skipped: string[] = [];
  const plan: { id: string; before: Ticket; next: Ticket; viaGrant?: string[] }[] = [];
  for (const id of ids) {
    const t = tickets.get(id);
    if (!t) {
      skipped.push(id);
      continue;
    }
    if (a.type === 'state') {
      if (t.state === a.state) continue; // already there: nothing to do
      if (!can(rc, board, stateAction(t.state))) {
        skipped.push(id);
        continue;
      }
    } else if (t.state !== 'active') {
      skipped.push(id); // closed tickets are read-only
      continue;
    }
    let viaGrant: string[] | undefined;
    if (a.type === 'stage') {
      if (!editor) {
        if (!can(rc, board, 'move', t, a.stageId)) {
          skipped.push(id);
          continue;
        }
        viaGrant = board.stageGrants[ctx.actor]?.stages;
      }
      if (
        t.stageId !== a.stageId &&
        missingForStage(findStage(board, a.stageId), t.fields).length
      ) {
        skipped.push(id);
        continue;
      }
    }
    const next = applyPatch(board, t, patchFor(t), ctx.now);
    if (!updatesFor(t, next).length) continue;
    plan.push({ id, before: t, next, ...(viaGrant ? { viaGrant } : {}) });
  }

  // Tickets entering a column go to its bottom, in request order.
  if (a.type === 'stage') {
    const moving = plan.filter((p) => p.before.stageId !== a.stageId);
    if (moving.length) {
      const ranks = betweenN(await lastRankInStage(boardId, a.stageId), null, moving.length);
      moving.forEach((p, i) => (p.next.rank = ranks[i]!));
    }
  }

  // ── batched writes ──
  const byName = await actorName(ctx, boardId);
  const size = a.type === 'state' ? BULK_BATCH_TICKETS_WITH_LINE : BULK_BATCH_TICKETS;
  for (const part of chunk(plan, size)) {
    const batch = db().batch();
    for (const p of part) {
      const w = batchWriter(batch, ctx, boardId, p.id, p.before);
      if (a.type === 'state') {
        writeStateChange(w, ctx, p.before.state, a.state, byName);
        w.commit();
        continue;
      }
      const pairs: Pair[] = [
        ...updatesFor(p.before, p.next),
        [['updatedAt'], ctx.now],
        [['lastActivityAt'], ctx.now],
      ];
      w.setPairs(pairs);
      w.addActivity(activityDoc(ctx, 'update', diff(p.before, p.next), p.viaGrant));
      w.commit();
    }
    await batch.commit();
  }

  // ── after commit ──
  const after: TicketWithId[] = plan.map((p) =>
    withTicketId(boardId, p.id, { ...p.next, updatedAt: ctx.now, lastActivityAt: ctx.now }),
  );
  if (after.length) await notifyDigest(a, plan, after, board.stages, byName, ctx);
  for (const [i, t] of after.entries()) {
    const before = plan[i]!.before;
    if (a.type === 'stage') {
      const from = board.stages.find((s) => s.id === before.stageId);
      await emitSafe(
        boardId,
        'ticket.moved',
        async () => ({
          ...(await toPublicTicket(board, t)),
          from_stage: from ? { id: from.id, name: from.name } : null,
        }),
        ctx,
      );
    } else if (a.type === 'state') {
      await emitSafe(boardId, 'ticket.state', () => toPublicTicket(board, t), ctx);
    } else {
      const changes = Object.keys(diff(before, t)).map((k) => k.split('.')[0]!);
      await emitSafe(
        boardId,
        'ticket.updated',
        async () => ({
          ...(await toPublicTicket(board, t)),
          changes: [...new Set(changes)],
        }),
        ctx,
      );
    }
  }

  return { updated: plan.length, skipped };
});

/** One notification per recipient for the whole run. */
async function notifyDigest(
  a: BulkAction,
  plan: { before: Ticket }[],
  after: TicketWithId[],
  stages: { id: string; name: string }[],
  byName: string,
  ctx: Parameters<typeof notifySafe>[2],
): Promise<void> {
  const first = after[0]!;
  const event =
    a.type === 'stage'
      ? 'stage'
      : a.type === 'state'
        ? 'state'
        : a.type === 'addAssignee'
          ? 'assigned'
          : 'updated';
  if (after.length === 1) {
    const changes = diff(plan[0]!.before, first);
    if (a.type === 'addAssignee')
      await notifySafe('assigned', first, ctx, { recipients: a.uid === ctx.actor ? [] : [a.uid] });
    else await notifySafe(event, first, ctx, { changes });
    return;
  }
  const n = after.length;
  const what =
    a.type === 'stage'
      ? `moved ${n} tickets to ${stages.find((s) => s.id === a.stageId)?.name ?? a.stageId}`
      : a.type === 'state'
        ? `${a.state === 'active' ? 'restored' : a.state} ${n} tickets`
        : a.type === 'addAssignee'
          ? `assigned you ${n} tickets`
          : `updated ${n} tickets`;
  const recipients =
    a.type === 'addAssignee'
      ? [a.uid]
      : [...new Set(after.flatMap((t) => [...t.watcherUids, ...t.assigneeUids]))];
  await notifySafe(event, first, ctx, {
    recipients: recipients.filter((u) => u !== ctx.actor),
    summary: `${byName} ${what}`,
  });
}

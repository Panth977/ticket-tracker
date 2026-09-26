/**
 * ticketUpdate (app/backend.json services.ticketUpdate).
 *
 *   state != 'active'                         → 409 (read-only)
 *   only stageId (+rank) and !can(edit)        → can(move, to) via StageGrant
 *   otherwise                                  → can(edit)
 *   ifUpdatedAt stale (title / description)    → 409 { current }
 *   entering a stage whose `requires` is unmet → 422 { missing }
 *
 * transaction: field-level merge of the patch; stageCategory / completedAt
 * follow the stage; links written on BOTH tickets (+ activity 'link' on
 * both); new description #refs get their backlink; activity 'update' carries
 * diff(before, after) and, for a limited move, which grant allowed it.
 *
 * after commit: notify stage / assigned / mentioned / updated; webhooks
 * ticket.moved (stage) and ticket.updated (anything else).
 */
import { can, changedKeys, diff, isEmptyDoc, setDelta, type CanCtx } from '@tm/shared/logic/index';
import {
  errors,
  isAgentId,
  patchScopes,
  paths,
  type Ticket,
  type TicketLink,
  type TicketWithId,
} from '@tm/shared';
import { agentEventsSafe } from '../agents/inbox.js';
import { runTx, txGetAll } from '../runtime/tx.js';
import { openTicket, writerFor } from '../tickets/doc.js';
import {
  loadBoard,
  loadTicket,
  requireActive,
  requireCan,
  requireWritableBoard,
  ticketRef,
  withBoardId,
  withTicketId,
} from '../tickets/access.js';
import { emitSafe, notifySafe } from '../tickets/effects.js';
import { applyDelta, inverseDeltas, normalizeLinks } from '../tickets/links.js';
import { locateTickets } from '../tickets/locate.js';
import { applyPatch, updatesFor, type CleanPatch, type Pair } from '../tickets/patch.js';
import { toPublicTicket } from '../platform/public.js';
import { rankAtEnd, rankBetween } from '../tickets/rank.js';
import { readRefTargets, writeReferences } from '../tickets/references.js';
import { parseBody, type ParsedBody } from '../tickets/richtext.js';
import {
  checkFields,
  checkMembers,
  checkPriority,
  checkTags,
  findStage,
  isEmptyValue,
  requireStageFields,
} from '../tickets/validate.js';
import { activityDoc } from '../tickets/writes.js';
import { db } from '../runtime/firebase.js';
import type { Board } from '@tm/shared';
import { defineCommand } from './_registry.js';

export default defineCommand('ticketUpdate', async (ctx, input) => {
  const { boardId, ticketId, patch: p } = input;
  const board = await loadBoard(ctx, boardId);
  requireWritableBoard(board);

  // A token needs EVERY scope the patch touches (agents.html §E): stageId →
  // tickets:move, assigneeUids → tickets:assign, the rest → tickets:update;
  // a pure re-rank is a move. The role checks below then run on the role alone.
  if (ctx.scopes) {
    const need = patchScopes(p);
    if (input.rank && !need.includes('tickets:move')) need.push('tickets:move');
    const missing = need.filter((s) => !ctx.scopes!.includes(s));
    if (missing.length)
      throw errors.forbidden(
        `This token lacks the ${missing.map((m) => `"${m}"`).join(', ')} scope`,
        {
          missing,
        },
      );
  }
  const role: CanCtx = { actor: ctx.actor, boardIds: ctx.boardIds ?? null };

  // ── validate what does not need the ticket ──
  const clean: CleanPatch = {};
  if (p.title !== undefined) clean.title = p.title;
  if (p.stageId !== undefined) clean.stageId = findStage(board, p.stageId).id;
  if (p.priorityId !== undefined) {
    checkPriority(board, p.priorityId);
    clean.priorityId = p.priorityId;
  }
  if (p.tagIds !== undefined) clean.tagIds = checkTags(board, p.tagIds);
  if (p.assigneeUids !== undefined)
    clean.assigneeUids = checkMembers(board, p.assigneeUids, 'assigneeUids');
  if (p.startAt !== undefined) clean.startAt = p.startAt;
  if (p.dueAt !== undefined) clean.dueAt = p.dueAt;
  if (p.dueAllDay !== undefined) clean.dueAllDay = p.dueAllDay;
  if (p.estimate !== undefined) clean.estimate = p.estimate;
  if (p.commitments !== undefined) {
    checkMembers(board, Object.keys(p.commitments), 'commitments');
    clean.commitments = p.commitments;
  }
  if (p.fields !== undefined) clean.fields = checkFields(board, p.fields);

  let parsed: ParsedBody | null = null;
  if (p.description !== undefined) {
    if (p.description === null || isEmptyDoc(p.description)) clean.description = null;
    else {
      parsed = await parseBody(p.description, board, ctx, ticketId);
      clean.description = parsed.rich;
    }
  }

  // Link targets: where they live (a link may point at another board).
  let linkWhere = new Map<string, { boardId: string }>();
  if (p.links !== undefined) {
    clean.links = normalizeLinks(ticketId, p.links);
    const before = await loadTicket(boardId, ticketId);
    const ids = [...new Set([...before.links, ...clean.links].map((l) => l.ticketId))];
    linkWhere = await locateTickets(ids, boardId);
    const missing = clean.links.filter((l) => !linkWhere.has(l.ticketId)).map((l) => l.ticketId);
    if (missing.length)
      throw errors.invalid('Linked tickets not found', { field: 'links', ticketIds: missing });
    // New links to tickets on other boards need read access there.
    const foreign = [...new Set(clean.links.map((l) => linkWhere.get(l.ticketId)!.boardId))].filter(
      (b) => b !== boardId,
    );
    for (const b of foreign) {
      const snap = await db().doc(paths.board(b)).get();
      if (!snap.exists || !can(ctx, withBoardId(b, snap.data() as Board), 'read'))
        throw errors.invalid('Linked tickets not found', { field: 'links' });
    }
  }

  const onlyMove = Object.keys(p).every((k) => k === 'stageId');
  const onlyAssign =
    Object.keys(p).length > 0 && Object.keys(p).every((k) => k === 'assigneeUids') && !input.rank;
  const touchesText = p.title !== undefined || p.description !== undefined;

  const res = await runTx(async (tx) => {
    // ── reads ──
    const w = await openTicket(tx, ctx, boardId, ticketId);
    const ticket = w.before;
    requireActive(ticket);

    let viaGrant: string[] | undefined;
    const toStage = clean.stageId ?? ticket.stageId;
    // Assigning is its own action (a token may hold tickets:assign alone).
    if (p.assigneeUids !== undefined) requireCan(role, board, 'assign');
    if (!onlyAssign && !can(role, board, 'edit')) {
      if (!onlyMove || (clean.stageId === undefined && !input.rank))
        requireCan(role, board, 'edit');
      requireCan(role, board, 'move', ticket, toStage, 'Your stage grant does not cover this move');
      viaGrant = board.stageGrants[ctx.actor]?.stages;
    }

    if (touchesText && input.ifUpdatedAt !== undefined && ticket.updatedAt > input.ifUpdatedAt) {
      throw errors.conflict('This ticket changed since you opened it', { current: ticket });
    }

    // Rank: explicit neighbours win; a stage change without them appends.
    if (input.rank && (input.rank.after || input.rank.before)) {
      const ids = [input.rank.after, input.rank.before];
      const [a, b] = await txGetAll(
        tx,
        ids.map((id) => ticketRef(boardId, id ?? ticketId)),
      );
      clean.rank = rankBetween(
        input.rank.after ? (a?.rank ?? null) : null,
        input.rank.before ? (b?.rank ?? null) : null,
      );
    } else if (clean.stageId !== undefined && clean.stageId !== ticket.stageId) {
      clean.rank = await rankAtEnd(boardId, clean.stageId, tx);
    }

    // Other tickets whose links change.
    const deltas = clean.links ? inverseDeltas(ticketId, ticket.links, clean.links) : new Map();
    const deltaIds = [...deltas.keys()].filter((id) => linkWhere.has(id));
    const others = await txGetAll(
      tx,
      deltaIds.map((id) => ticketRef(linkWhere.get(id)!.boardId, id)),
    );
    const refTargets = parsed
      ? await readRefTargets(
          tx,
          parsed.rich.refs.filter((r) => !ticket.refs.includes(r)),
          parsed.refAt,
        )
      : [];
    if (refTargets.length) clean.addRefs = refTargets.map((t) => t.id);

    // ── compute ──
    const next = applyPatch(board, ticket, clean, ctx.now);
    if (next.stageId !== ticket.stageId)
      requireStageFields(findStage(board, next.stageId), next.fields);
    const cleared = board.fields.filter(
      (f) =>
        f.required &&
        !f.archived &&
        !isEmptyValue(ticket.fields[f.id]) &&
        isEmptyValue(next.fields[f.id]),
    );
    if (cleared.length)
      throw errors.invalid('Required fields cannot be cleared', {
        missing: cleared.map((f) => f.id),
      });
    if (next.startAt !== null && next.dueAt !== null && next.startAt > next.dueAt)
      throw errors.invalid('Start must be before due', { field: 'startAt' });

    const changes = diff(ticket, next);
    const { links: linkChange, ...otherChanges } = changes;
    const pairs = updatesFor(ticket, next);
    if (!pairs.length)
      return { ticket, next: ticket, changes: {}, updatedAt: ticket.updatedAt, wrote: false };

    // Only a real change bumps updatedAt (a pure re-rank is not an edit).
    const edited = Object.keys(changes).length > 0;
    const updatedAt = edited ? ctx.now : ticket.updatedAt;
    if (edited) next.updatedAt = updatedAt;
    next.lastActivityAt = ctx.now;

    // ── writes ── §W: the patch, both activity rows and the other tickets'
    // links are one write each, on the ticket documents themselves.
    const stamps: Pair[] = [[['lastActivityAt'], ctx.now]];
    if (edited) stamps.push([['updatedAt'], updatedAt]);
    w.setPairs([...pairs, ...stamps]);
    if (Object.keys(otherChanges).length)
      w.addActivity(activityDoc(ctx, 'update', otherChanges, viaGrant));
    if (linkChange) {
      w.addActivity(activityDoc(ctx, 'link', { links: linkChange }));
      deltaIds.forEach((id, i) => {
        const other = others[i] as Ticket | undefined;
        if (!other) return; // vanished: nothing to keep true
        const b = linkWhere.get(id)!.boardId;
        const links: TicketLink[] = applyDelta(other.links, deltas.get(id)!);
        const ow = writerFor(tx, ctx, b, id, other);
        ow.set({ links });
        ow.addActivity(activityDoc(ctx, 'link', { links: { from: other.links, to: links } }));
        ow.touch();
        ow.commit();
      });
    }
    w.commit();
    writeReferences(tx, ctx, { id: ticketId, key: ticket.key, boardId }, refTargets);
    return { ticket, next, changes, updatedAt, wrote: true };
  });

  if (!res.wrote || !Object.keys(res.changes).length)
    return { ok: true as const, updatedAt: res.updatedAt };

  // ── after commit ──
  const after: TicketWithId = withTicketId(boardId, ticketId, res.next);
  const { stage: stageChange, ...rest } = res.changes;
  const assignDelta = setDelta(res.ticket.assigneeUids, res.next.assigneeUids);
  const added = assignDelta.added.filter((u) => u !== ctx.actor);
  // Agents taken off the ticket hear it in their inbox (people are not told).
  await agentEventsSafe('unassigned', after, ctx, assignDelta.removed);
  const oldMentions = res.ticket.description?.mentions ?? [];
  const mentioned = (res.next.description?.mentions ?? []).filter(
    (u) => !oldMentions.includes(u) && u !== ctx.actor,
  );

  if (stageChange) await notifySafe('stage', after, ctx, { changes: { stage: stageChange } });
  await notifySafe('assigned', after, ctx, { recipients: added });
  await notifySafe('mentioned', after, ctx, { mentioned });
  if (Object.keys(rest).length)
    await notifySafe('updated', after, ctx, {
      changes: rest,
      // Agents taken off it got 'unassigned' above — not a second event.
      exclude: [...new Set([...added, ...mentioned, ...assignDelta.removed.filter(isAgentId)])],
    });

  if (stageChange) {
    const from = board.stages.find((s) => s.id === res.ticket.stageId);
    await emitSafe(
      boardId,
      'ticket.moved',
      async () => ({
        ...(await toPublicTicket(board, after)),
        from_stage: from ? { id: from.id, name: from.name } : null,
      }),
      ctx,
    );
  }
  if (Object.keys(rest).length) {
    await emitSafe(
      boardId,
      'ticket.updated',
      async () => ({ ...(await toPublicTicket(board, after)), changes: changedKeys(rest) }),
      ctx,
    );
  }
  return { ok: true as const, updatedAt: res.updatedAt };
});

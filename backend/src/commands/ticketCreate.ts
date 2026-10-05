/**
 * ticketCreate (app/backend.json services.ticketCreate).
 *
 *   can(create) → validate stage / priority / tags / fields / assignees
 *   → parseRichText(description) → memoryUploads' objects exist (memory.html §J;
 *     `attachments` is retired and refused)
 *   transaction: allocateKey, ticket (rank = end of its column, watchers =
 *     actor + assignees), activity 'create', files/ rows, referencedBy on refs,
 *     and the memoryUploads' new memory nodes ('<ticketId>' = the new key)
 *   after commit: notify created / assigned / mentioned; webhook ticket.created
 *
 * A retried create is one ticket: the runner replays by clientId, and a
 * client-chosen ticketId that already exists is a 409, never a second ticket.
 */
import { errors, isIntakeActor, type Ticket } from '@tm/shared';
import { isEmptyDoc, ticketKey } from '@tm/shared/logic/index';
import { firstStage } from '@tm/shared/logic/stages';
import { runTx, txGet } from '../runtime/tx.js';
import {
  boardRef,
  loadBoard,
  loadBoardForIntake,
  requireCan,
  requireWritableBoard,
  ticketRef,
  withTicketId,
} from '../tickets/access.js';
import { refuseBoardAttachments } from '../tickets/attachments.js';
import { resolveMemoryRefs } from '../memory/refs.js';
import { planMemoryUploads, stageMemoryUploads, withUploads } from '../memory/attach.js';
import { emitSafe, notifySafe } from '../tickets/effects.js';
import { allocateKey } from '../tickets/keys.js';
import { toPublicTicket } from '../platform/public.js';
import { rankAtEnd } from '../tickets/rank.js';
import { readRefTargets, writeReferences } from '../tickets/references.js';
import { parseBody } from '../tickets/richtext.js';
import {
  checkFields,
  checkMembers,
  checkPriority,
  checkTags,
  findStage,
  missingRequired,
  requireStageFields,
} from '../tickets/validate.js';
import { actorName, activityDoc, fileRows } from '../tickets/writes.js';
import { withInline } from '../tickets/doc.js';
import { defineCommand } from './_registry.js';

export default defineCommand('ticketCreate', async (ctx, input) => {
  // Intake widget / email-to-board: a system actor on no board; the door has
  // already authorised the request (secret / intake address) and narrowed
  // ctx.boardIds to that one board.
  const intake = isIntakeActor(ctx);
  const board = intake
    ? await loadBoardForIntake(ctx, input.boardId)
    : await loadBoard(ctx, input.boardId);
  if (!intake) requireCan(ctx, board, 'create');
  if (input.reporter && !intake)
    throw errors.invalid('reporter is set by the intake doors only', { field: 'reporter' });
  requireWritableBoard(board);
  // memory.html §J: a board takes no files of its own any more.
  refuseBoardAttachments(input.attachments);

  // §Q3: no stage named → the board's FIRST stage by position (the leftmost
  // column), the same place a column's '+' puts it — not the first 'todo' one.
  const stage = input.stageId ? findStage(board, input.stageId) : firstStage(board);
  checkPriority(board, input.priorityId);
  const tagIds = checkTags(board, input.tagIds ?? []);
  const assigneeUids = checkMembers(board, input.assigneeUids ?? [], 'assigneeUids');
  // A token assigning people / agents on create also needs tickets:assign
  // (agents.html §E). The intake doors assign by their own configuration.
  if (!intake && assigneeUids.length && ctx.scopes && !ctx.scopes.includes('tickets:assign'))
    throw errors.forbidden('This token lacks the "tickets:assign" scope', {
      missing: ['tickets:assign'],
    });
  const fields = checkFields(board, input.fields ?? {});
  for (const [k, v] of Object.entries(fields)) if (v === null) delete fields[k];
  const missing = missingRequired(board, fields);
  if (missing.length) throw errors.invalid('Required fields are missing', { missing });
  requireStageFields(stage, fields);
  if (input.startAt != null && input.dueAt != null && input.startAt > input.dueAt)
    throw errors.invalid('Start must be before due', { field: 'startAt' });

  const ticketId = input.ticketId ?? ctx.ids.id();
  const parsed =
    input.description && !isEmptyDoc(input.description)
      ? await parseBody(input.description, board, ctx, ticketId)
      : null;
  // memory.html §E: memory files by reference (the memory must be granted to this board).
  const memoryFiles = await resolveMemoryRefs(ctx, input.memoryRefs, board.id);
  const byName = intake
    ? input.reporter?.name || input.reporter?.email || 'Intake'
    : await actorName(ctx, board.id);
  // memory.html §J: files just uploaded INTO a memory. Their paths may hold
  // '<ticketId>', and the key is only known inside the transaction (the
  // board's counter) — so they are planned THERE, from the key the counter
  // will give, and written in the same commit as the ticket. Staged last,
  // after every cheap refusal; a failure from here on removes them again.
  const staged = await stageMemoryUploads(input.memoryUploads);

  const { ticket } = await withUploads(staged, () =>
    runTx(async (tx) => {
      // ── reads ──
      const fresh = await txGet(tx, boardRef(board.id));
      if (!fresh) throw errors.not_found('Board not found');
      if (await txGet(tx, ticketRef(board.id, ticketId)))
        throw errors.conflict('A ticket with this id already exists', { ticketId });
      const rank = await rankAtEnd(board.id, stage.id, tx);
      const targets = parsed ? await readRefTargets(tx, parsed.rich.refs, parsed.refAt) : [];
      // The key allocateKey will issue below (same counter, same transaction).
      const upcoming = ticketKey(fresh.key, fresh.nextNumber);
      const plan = await planMemoryUploads(tx, ctx, staged, board.id, upcoming);

      // ── writes ──
      const { key, number } = allocateKey(tx, boardRef(board.id), fresh, board.id, ticketId);
      if (key !== upcoming) throw new Error('allocateKey disagreed with the planned key');
      plan.write(tx);
      const memoryRows = [...plan.attachments, ...memoryFiles];
      const fields0: Ticket = {
        key,
        number,
        title: input.title,
        description: parsed?.rich ?? null,
        stageId: stage.id,
        stageCategory: stage.category,
        priorityId: input.priorityId ?? null,
        tagIds,
        state: 'active',
        rank,
        assigneeUids,
        watcherUids: intake
          ? [...new Set(assigneeUids)]
          : [...new Set([ctx.actor, ...assigneeUids])],
        reporter: intake
          ? { uid: null, name: byName, ...(input.reporter ? { email: input.reporter.email } : {}) }
          : { uid: ctx.actor, name: byName, ...(ctx.email ? { email: ctx.email } : {}) },
        startAt: input.startAt ?? null,
        dueAt: input.dueAt ?? null,
        dueAllDay: input.dueAllDay ?? false,
        commitments: {},
        estimate: input.estimate ?? null,
        fields,
        refs: targets.map((t) => t.id),
        referencedBy: [],
        links: [],
        counts: { messages: 0, files: memoryRows.length, pinned: 0 },
        lastMessageAt: null,
        lastActivityAt: ctx.now,
        dueNotified: {},
        createdBy: ctx.actor,
        createdVia: ctx.via,
        createdAt: ctx.now,
        updatedAt: ctx.now,
        completedAt: stage.category === 'done' ? ctx.now : null,
      };
      // §W: the ticket IS the thread — its first activity row and the files that
      // arrived with the description go inside the document being created.
      const doc = withInline(fields0, {
        activity: [{ ...activityDoc(ctx, 'create', {}), id: ctx.ids.id() }],
        files: fileRows(memoryRows, 'memory', null, ctx.now),
      });
      tx.create(ticketRef(board.id, ticketId), doc);
      writeReferences(tx, ctx, { id: ticketId, key, boardId: board.id }, targets);
      return { ticket: withTicketId(board.id, ticketId, doc) };
    }),
  );

  const mentioned = (ticket.description?.mentions ?? []).filter((u) => u !== ctx.actor);
  const assigned = ticket.assigneeUids.filter((u) => u !== ctx.actor);
  await notifySafe('created', ticket, ctx, { exclude: [...new Set([...assigned, ...mentioned])] });
  await notifySafe('assigned', ticket, ctx, { recipients: assigned });
  await notifySafe('mentioned', ticket, ctx, { mentioned });
  await emitSafe(board.id, 'ticket.created', () => toPublicTicket(board, ticket), ctx);

  return { ticketId, key: ticket.key };
});

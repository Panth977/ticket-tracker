/**
 * THE PHASE-3 API OPERATIONS (docs/plan/agents.html §L4) — questions with
 * options, ticket task lists and the agent heartbeat, written once and used by
 * both REST /v1 (doors/rest.ts) and MCP (doors/mcp.ts), exactly like
 * platform/v1.ts does for phase 2.
 *
 *   door → zod parse → names to ids (resolve.ts) → THE SAME COMMAND the app
 *        calls (ops.invoke) → re-read the document → toPublic
 *
 * Three things are worth knowing:
 *   - a question IS a message (kind 'question'), so its id is
 *     questionId(ticketId, messageId) and REST can address it without a
 *     ticket in the path (GET /v1/questions/{id});
 *   - ANSWERING is deliberately not here: a person answers in the app
 *     (questionAnswer), because a token that could answer its own question
 *     would defeat the point (§L1);
 *   - a heartbeat never touches the ticket, and since §W it never touches
 *     Firestore either: it writes ONE ~100-byte RTDB node
 *     (status/{boardId}/{agentId}/{ticketId|'_'}), so a beat a minute costs no
 *     operations at all and re-renders nothing. Reads here come back through
 *     platform/rtdbPaths.ts in the same AgentStatus shape as before.
 */
import {
  agentStatusId,
  errors,
  isAgentId,
  parseAgentStatusId,
  parseQuestionId,
  paths,
  type AgentState,
  type BoardMember,
  type BoardWithId,
  type Message,
  type PublicAgentStatus,
  type PublicQuestion,
  type PublicTasklist,
  type QuestionField,
  type RestAskQuestionBody,
  type RestSetTasklistBody,
  type TaskItemStatus,
  type Tasklist,
  type TicketWithId,
} from '@tm/shared';
import type { ServerCtx } from '../runtime/context.js';
import { db } from '../runtime/firebase.js';
import { loadTicket } from '../tickets/access.js';
import { getMessage, getTasklist, readTasklists } from '../tickets/read.js';
import { locateTickets } from '../tickets/locate.js';
import { invoke } from './ops.js';
import { boardMembers, toPublicAgentStatus, toPublicQuestion, toPublicTasklist } from './public.js';
import { markdownIn, peopleUids, readableBoards, ticketByKey } from './resolve.js';
import { readBoardStatuses, readStatus } from './rtdbPaths.js';

// ─── questions (§L1) ─────────────────────────────────────────────────────────

/** Where a question lives, plus everything toPublicQuestion needs. */
interface FoundQuestion {
  board: BoardWithId;
  ticket: TicketWithId;
  messageId: string;
  message: Message;
}

/** ISO (REST) → millis, with the field name in the error. */
function atMillis(iso: string, field: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw errors.invalid(`"${iso}" is not a date`, { field });
  return ms;
}

/**
 * A question by its API id ('{ticketId}.{messageId}'). The board is not in the
 * id — the credential's boards are — so this looks for the ticket on each
 * board this credential may read (one getAll, at most 30 boards), then reads
 * the one message. A question on a board the caller cannot read is a 404,
 * indistinguishable from one that never existed.
 */
export async function findQuestion(ctx: ServerCtx, id: string): Promise<FoundQuestion> {
  const parsed = parseQuestionId(id);
  if (!parsed) throw errors.not_found('Question not found');
  const boards = (await readableBoards(ctx, { includeArchived: true })).slice(0, 30);
  if (!boards.length) throw errors.not_found('Question not found');
  const snaps = await db().getAll(
    ...boards.map((b) => db().doc(paths.ticket(b.id, parsed.ticketId))),
  );
  const i = snaps.findIndex((s) => s.exists);
  if (i < 0) throw errors.not_found('Question not found');
  const board = boards[i]!;
  const ticket = await loadTicket(board.id, parsed.ticketId);
  // §W: the question is a row on the ticket we just read.
  const message = await getMessage(board.id, ticket.id, parsed.messageId, ticket);
  if (!message || message.kind !== 'question' || !message.question || message.deletedAt !== null) {
    throw errors.not_found('Question not found');
  }
  return { board, ticket, messageId: parsed.messageId, message };
}

async function questionView(
  ctx: ServerCtx,
  f: FoundQuestion,
  members?: Map<string, BoardMember>,
): Promise<PublicQuestion> {
  const m = members ?? (await boardMembers(f.board.id));
  const refs = f.message.question?.body?.refs ?? [];
  const located = refs.length
    ? await locateTickets(refs, f.board.id)
    : new Map<string, { key: string }>();
  return toPublicQuestion(
    { id: f.ticket.id, key: f.ticket.key },
    f.messageId,
    f.message,
    f.message.question!,
    m,
    ctx.now,
    (id) => located.get(id)?.key,
  );
}

/** GET /v1/questions/{id}, MCP get_question. */
export async function getQuestion(ctx: ServerCtx, id: string): Promise<PublicQuestion> {
  return questionView(ctx, await findQuestion(ctx, id));
}

/** Re-read a question after a command wrote it (the card as it now stands). */
async function reloadQuestion(
  ctx: ServerCtx,
  board: BoardWithId,
  ticket: TicketWithId,
  messageId: string,
): Promise<PublicQuestion> {
  const message = await getMessage(board.id, ticket.id, messageId);
  if (!message?.question) throw errors.not_found('Question not found');
  return questionView(ctx, { board, ticket, messageId, message });
}

/**
 * POST /v1/tickets/{KEY}/questions, MCP ask_question. `to` is named the way
 * everything else is (me / id / email / agent name); the Markdown body becomes
 * the same rich text a message body holds.
 */
export async function askQuestion(
  ctx: ServerCtx,
  board: BoardWithId,
  ticket: TicketWithId,
  q: {
    title: string;
    body_markdown?: string | null | undefined;
    fields: RestAskQuestionBody['fields'];
    allow_comment?: boolean | undefined;
    to?: readonly string[] | null | undefined;
    blocking?: boolean | undefined;
    /** Already millis (MCP parses 'fri' itself); REST passes ISO through atMillis. */
    expires_at?: number | null | undefined;
  },
  key?: string,
): Promise<PublicQuestion> {
  const md = q.body_markdown?.trim();
  const members = q.to?.length ? await boardMembers(board.id) : new Map<string, BoardMember>();
  const res = await invoke(
    'questionAsk',
    {
      boardId: board.id,
      ticketId: ticket.id,
      title: q.title,
      ...(md ? { body: await markdownIn(md, board) } : {}),
      // The public field shape and the stored one are the same rows.
      fields: q.fields as QuestionField[],
      ...(q.allow_comment !== undefined ? { allowComment: q.allow_comment } : {}),
      ...(q.to === null
        ? { to: null }
        : q.to?.length
          ? { to: peopleUids(ctx, board, members, [...q.to]) }
          : {}),
      ...(q.blocking !== undefined ? { blocking: q.blocking } : {}),
      ...(q.expires_at !== undefined ? { expiresAt: q.expires_at } : {}),
    },
    ctx,
    key ?? null,
  );
  return reloadQuestion(ctx, board, ticket, res.messageId);
}

/** POST /v1/questions/{id}/cancel, MCP cancel_question — answers the locked card. */
export async function cancelQuestion(
  ctx: ServerCtx,
  id: string,
  key?: string,
): Promise<PublicQuestion> {
  const f = await findQuestion(ctx, id);
  await invoke(
    'questionCancel',
    { boardId: f.board.id, ticketId: f.ticket.id, messageId: f.messageId },
    ctx,
    key ?? null,
  );
  return reloadQuestion(ctx, f.board, f.ticket, f.messageId);
}

/** REST passes ISO; this is the one place it becomes millis. */
export const questionExpiry = (iso: string | null | undefined): number | null | undefined =>
  iso === undefined ? undefined : iso === null ? null : atMillis(iso, 'expires_at');

// ─── task lists (§L2) ────────────────────────────────────────────────────────

async function tasklistView(
  board: BoardWithId,
  ticket: TicketWithId,
  listId: string,
): Promise<PublicTasklist> {
  const [list, members] = await Promise.all([
    getTasklist(board.id, ticket.id, listId),
    boardMembers(board.id),
  ]);
  if (!list) throw errors.not_found('Task list not found');
  return toPublicTasklist(ticket.key, listId, list as Tasklist, members);
}

/** GET /v1/tickets/{KEY}/tasklists — in the order the drawer shows them. */
export async function listTasklists(
  board: BoardWithId,
  ticket: TicketWithId,
): Promise<PublicTasklist[]> {
  // §W: the lists are a field of the ticket, already in `position` order.
  const [lists, members] = await Promise.all([
    readTasklists(board.id, ticket.id, ticket),
    boardMembers(board.id),
  ]);
  return lists.map((l) => toPublicTasklist(ticket.key, l.id, l as Tasklist, members));
}

/**
 * PUT /v1/tickets/{KEY}/tasklists/{listId}, MCP set_tasklist — create or
 * REPLACE the whole list, so an agent re-publishing its plan never has to diff
 * it. Item ids are kept when given, which keeps an item's identity across a
 * replace.
 */
export async function setTasklist(
  ctx: ServerCtx,
  board: BoardWithId,
  ticket: TicketWithId,
  listId: string | undefined,
  b: RestSetTasklistBody,
  key?: string,
): Promise<PublicTasklist> {
  const res = await invoke(
    'tasklistSet',
    {
      boardId: board.id,
      ticketId: ticket.id,
      ...(listId ? { listId } : {}),
      title: b.title,
      items: b.items.map((i) => ({
        ...(i.id ? { id: i.id } : {}),
        title: i.title,
        ...(i.status ? { status: i.status } : {}),
        ...(i.note !== undefined ? { note: i.note } : {}),
      })),
      ...(b.position !== undefined ? { position: b.position } : {}),
      ...(b.closed !== undefined ? { closed: b.closed } : {}),
    },
    ctx,
    key ?? null,
  );
  return tasklistView(board, ticket, res.listId);
}

/**
 * PATCH …/tasklists/{listId}/items/{itemId}, MCP update_task_item — the
 * one-item hot path an agent calls as it works (no thread line, no activity
 * row). Answers the whole list, so the caller sees the new progress.
 */
export async function updateTaskItem(
  ctx: ServerCtx,
  board: BoardWithId,
  ticket: TicketWithId,
  listId: string,
  itemId: string,
  patch: { status?: TaskItemStatus | undefined; note?: string | null | undefined },
  key?: string,
): Promise<PublicTasklist> {
  await invoke(
    'tasklistItemUpdate',
    {
      boardId: board.id,
      ticketId: ticket.id,
      listId,
      itemId,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
    },
    ctx,
    key ?? null,
  );
  return tasklistView(board, ticket, listId);
}

/** DELETE /v1/tickets/{KEY}/tasklists/{listId}, MCP delete_tasklist. */
export async function deleteTasklist(
  ctx: ServerCtx,
  board: BoardWithId,
  ticket: TicketWithId,
  listId: string,
  key?: string,
): Promise<{ deleted: true }> {
  await invoke(
    'tasklistDelete',
    { boardId: board.id, ticketId: ticket.id, listId },
    ctx,
    key ?? null,
  );
  return { deleted: true };
}

// ─── heartbeat (§L3) ─────────────────────────────────────────────────────────

/**
 * POST /v1/heartbeat, MCP heartbeat. `ticket` is a KEY (omit it for an
 * agent-level beat); the beat lands in ONE RTDB node and NOWHERE else, which
 * is the whole point of §L3 — and since §W that node costs no operations at
 * all, so an agent may beat as often as it likes.
 */
export async function heartbeat(
  ctx: ServerCtx,
  board: BoardWithId,
  b: {
    ticket?: string | undefined;
    state: AgentState;
    message?: string | null | undefined;
    progress?: number | null | undefined;
  },
): Promise<PublicAgentStatus> {
  let ticket: TicketWithId | null = null;
  if (b.ticket) {
    const found = await ticketByKey(ctx, b.ticket);
    if (found.board.id !== board.id)
      throw errors.not_found(`Ticket ${b.ticket} is not on board ${board.key}`);
    ticket = found.ticket;
  }
  const res = await invoke(
    'agentHeartbeat',
    {
      boardId: board.id,
      ...(ticket ? { ticketId: ticket.id } : {}),
      state: b.state,
      ...(b.message !== undefined ? { message: b.message } : {}),
      ...(b.progress !== undefined ? { progress: b.progress } : {}),
    },
    ctx,
    // A beat is its own idempotency: the same node, overwritten.
    null,
  );
  const ids = parseAgentStatusId(res.statusId);
  const [status, members] = await Promise.all([
    ids ? readStatus(board.id, ids.agentId, ids.ticketId) : Promise.resolve(null),
    boardMembers(board.id),
  ]);
  if (!status) throw errors.not_found('Status not found');
  return toPublicAgentStatus(status, ticket?.key ?? null, members, ctx.now);
}

/**
 * GET /v1/agents/status?ticket=KEY — what every agent on the board is doing,
 * the one query the board makes (§L3). An agent token sees only its own rows,
 * since another agent's status is none of its business.
 */
export async function agentStatuses(
  ctx: ServerCtx,
  board: BoardWithId,
  ticketKey?: string,
): Promise<PublicAgentStatus[]> {
  let ticketId: string | null = null;
  if (ticketKey) {
    const found = await ticketByKey(ctx, ticketKey);
    if (found.board.id !== board.id)
      throw errors.not_found(`Ticket ${ticketKey} is not on board ${board.key}`);
    ticketId = found.ticket.id;
  }
  const [statuses, members] = await Promise.all([
    readBoardStatuses(board.id),
    boardMembers(board.id),
  ]);
  const rows = statuses
    .map((s) => ({ s }))
    .filter(({ s }) => {
      if (ticketId !== null && s.ticketId !== ticketId) return false;
      if (isAgentId(ctx.actor) && s.agentId !== ctx.actor) return false;
      return true;
    });
  const ids = [...new Set(rows.map(({ s }) => s.ticketId).filter((x): x is string => x !== null))];
  const located = ids.length
    ? await locateTickets(ids, board.id)
    : new Map<string, { key: string }>();
  return rows
    .sort((a, b) => b.s.lastBeatAt - a.s.lastBeatAt)
    .map(({ s }) =>
      toPublicAgentStatus(
        s,
        s.ticketId ? (located.get(s.ticketId)?.key ?? null) : null,
        members,
        ctx.now,
      ),
    );
}

/** The status id a beat answers with (exported for the tests). */
export const statusIdFor = (agentId: string, ticketId: string | null): string =>
  agentStatusId(agentId, ticketId);

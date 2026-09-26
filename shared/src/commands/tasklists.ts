/**
 * Phase 3 — TASK LISTS (§L2) and the HEARTBEAT (§L3).
 *
 * tasklistSet writes the WHOLE list (create or replace), because an agent
 * re-publishing its plan should not have to diff it. tasklistItemUpdate is the
 * one-item hot path an agent calls as it works — it writes no activity row and
 * no thread line, so ticking items never floods the thread (§L2).
 */
import { z } from 'zod';
import {
  MAX_TASKLIST_ITEMS,
  TASK_ITEM_NOTE_MAX,
  TASK_ITEM_TITLE_MAX,
  TASKLIST_TITLE_MAX,
  TaskItemStatusSchema,
} from '../schema/tasklist.js';
import { AGENT_STATUS_MESSAGE_MAX, AgentStateSchema } from '../schema/agentStatus.js';
import {
  AgentIdSchema,
  BoardIdSchema,
  LocalIdSchema,
  MillisSchema,
  TicketIdSchema,
} from '../types/index.js';
import { defineCommand, OkResSchema, req } from './define.js';

const TicketRef = { boardId: BoardIdSchema, ticketId: TicketIdSchema };
const ListId = LocalIdSchema;

/** One item as the caller gives it; `updatedAt` is stamped by the server. */
export const TaskItemInputSchema = z
  .object({
    /** Keep an item's id to keep its identity (and its updatedAt when nothing changed). */
    id: LocalIdSchema.optional(),
    title: z.string().trim().min(1).max(TASK_ITEM_TITLE_MAX),
    /** Default 'todo'. */
    status: TaskItemStatusSchema.optional(),
    note: z.string().max(TASK_ITEM_NOTE_MAX).optional(),
  })
  .strict();
export type TaskItemInput = z.infer<typeof TaskItemInputSchema>;

export const tasklistSet = defineCommand({
  name: 'tasklistSet',
  source: 'phase3',
  scopes: ['tasklists:write'],
  permission:
    "canEditTasklist(): editor+, or the list's owner (a commenter agent through its token). Creating one sets owner = the actor; replacing one keeps the owner. The ticket must be active (409). Creating a list, and closing it, each add a system line to the thread.",
  errors: ['forbidden', 'not_found', 'conflict', 'invalid'],
  req: req({
    ...TicketRef,
    /** Absent = create with a generated id. Present = create-or-replace that list. */
    listId: ListId.optional(),
    title: z.string().trim().min(1).max(TASKLIST_TITLE_MAX),
    items: z.array(TaskItemInputSchema).max(MAX_TASKLIST_ITEMS),
    /** Order among the ticket's lists; default: after the last one. */
    position: z.number().optional(),
    /** true closes the list ('Plan finished' in the thread); false reopens it. */
    closed: z.boolean().optional(),
  }),
  res: z.object({ listId: ListId, itemIds: z.array(LocalIdSchema) }),
});

export const tasklistItemUpdate = defineCommand({
  name: 'tasklistItemUpdate',
  source: 'phase3',
  scopes: ['tasklists:write'],
  permission:
    "canEditTasklist() on the stored list — editor+, or its owner. People tick items by hand through the same command. No thread line, no activity row; only the item's status, note and updatedAt change.",
  errors: ['forbidden', 'not_found', 'conflict'],
  req: req({
    ...TicketRef,
    listId: ListId,
    itemId: LocalIdSchema,
    status: TaskItemStatusSchema.optional(),
    /** null clears the note; absent leaves it. */
    note: z.string().max(TASK_ITEM_NOTE_MAX).nullable().optional(),
  }).refine((r) => r.status !== undefined || r.note !== undefined, {
    message: 'Nothing to update',
  }),
  res: z.object({ ok: z.literal(true), updatedAt: MillisSchema }),
});

export const tasklistDelete = defineCommand({
  name: 'tasklistDelete',
  source: 'phase3',
  scopes: ['tasklists:write'],
  permission:
    'canEditTasklist() on the stored list — editor+, or its owner. Deleting is silent (no thread line).',
  errors: ['forbidden', 'not_found'],
  req: req({ ...TicketRef, listId: ListId }),
  res: OkResSchema,
});

export const agentHeartbeat = defineCommand({
  name: 'agentHeartbeat',
  source: 'phase3',
  scopes: ['status:write'],
  permission:
    "canHeartbeat(): a token acting as the agent (or a board admin) with status:write. Writes boards/{b}/agentStatus/{agentId}__{ticketId|'_'} only — never the ticket, so a beat a minute costs one small write.",
  errors: ['forbidden', 'not_found', 'invalid'],
  req: req({
    boardId: BoardIdSchema,
    /** Absent = an agent-level beat, about no ticket in particular. */
    ticketId: TicketIdSchema.optional(),
    /** Absent = ctx.actor, which is the agent when an agent token calls it. */
    agentId: AgentIdSchema.optional(),
    state: AgentStateSchema,
    /** 'Running tests (3/12)'. null clears it. */
    message: z.string().max(AGENT_STATUS_MESSAGE_MAX).nullable().optional(),
    progress: z.number().min(0).max(1).nullable().optional(),
  }),
  res: z.object({
    ok: z.literal(true),
    /** agentStatusId(agentId, ticketId ?? null) — the document that was written. */
    statusId: z.string(),
    /** The beat's time, as stored in lastBeatAt (= ctx.now). */
    at: MillisSchema,
  }),
});

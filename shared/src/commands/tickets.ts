/**
 * Ticket and thread commands (app/backend.json services).
 *
 * CONTRACT NOTE: the spec names tickets and messages by id alone. Every
 * ticket-scoped command here ALSO takes `boardId`, because a document path
 * needs it (boards/{b}/tickets/{t}) and a collection-group lookup by document
 * id is not possible. The client always knows it; REST/MCP resolve it from
 * keys/{KEY}. A stale boardId (the ticket was deleted) answers 404.
 */
import { z } from 'zod';
import { MEMORY_REFS_MAX, MemoryRefSchema } from '../memory/schema.js';
import { MemoryUploadSchema } from '../memory/attach.js';
import {
  BoardIdSchema,
  FieldValueSchema,
  MillisSchema,
  RichTextDocSchema,
  StoragePathSchema,
  TicketIdSchema,
  TicketKeySchema,
  TicketLinkSchema,
  TicketStateSchema,
  PrincipalIdSchema,
  type Scope,
  UidSchema,
} from '../types/index.js';
import { RunReceiptSchema } from '../schema/message.js';
import { ClientIdSchema, defineCommand, OkResSchema, req } from './define.js';

export const MAX_BULK_TICKETS = 500;
export const MAX_ATTACHMENTS_PER_CALL = 20;

const TicketRef = { boardId: BoardIdSchema, ticketId: TicketIdSchema };

export const ticketCreate = defineCommand({
  name: 'ticketCreate',
  source: 'app',
  scopes: ['tickets:create'],
  permission:
    'can(create) = editor+ — or INTAKE_ACTOR via intake | email (those doors authorise it). Assignees must be members (400 naming them); required fields present.',
  errors: ['forbidden', 'not_found', 'conflict'],
  req: req({
    boardId: BoardIdSchema,
    /**
     * Optional client-generated id. Needed when attachments were uploaded
     * before the ticket existed: they live under boards/{b}/tickets/{ticketId}/…
     */
    ticketId: TicketIdSchema.optional(),
    title: z.string().trim().min(1).max(500),
    description: RichTextDocSchema.optional(),
    /** Default: the board's FIRST stage by position — the leftmost column (§Q3). */
    stageId: z.string().min(1).optional(),
    priorityId: z.string().min(1).nullable().optional(),
    tagIds: z.array(z.string().min(1)).optional(),
    /** Principals: people and agents on the board. */
    assigneeUids: z.array(PrincipalIdSchema).optional(),
    startAt: MillisSchema.nullable().optional(),
    dueAt: MillisSchema.nullable().optional(),
    dueAllDay: z.boolean().optional(),
    estimate: z.number().nonnegative().nullable().optional(),
    fields: z.record(z.string(), FieldValueSchema).optional(),
    /**
     * RETIRED (memory.html §J): a board takes no files of its own any more —
     * a non-empty list is refused. Use memoryUploads / memoryRefs.
     */
    attachments: z.array(StoragePathSchema).max(MAX_ATTACHMENTS_PER_CALL).optional(),
    /**
     * memory.html §J: files just uploaded INTO a memory granted `write` to this
     * board, each to become a new file at its path ('<ticketId>' in it is
     * filled with the new ticket's key) and attached by reference.
     */
    memoryUploads: z.array(MemoryUploadSchema).max(MAX_ATTACHMENTS_PER_CALL).optional(),
    /**
     * memory.html §E: memory files to attach BY REFERENCE (no upload). The
     * memory must be granted to this board; each becomes a ticket.files row
     * with source 'memory'.
     */
    memoryRefs: z.array(MemoryRefSchema).max(MEMORY_REFS_MAX).optional(),
    /**
     * Who reported it from outside (intake widget, email-to-board). Only the
     * intake actor may set it (INTAKE_ACTOR, via intake | email); anyone else → 400.
     */
    reporter: z
      .object({ email: z.string().email().max(320), name: z.string().trim().max(120).optional() })
      .strict()
      .optional(),
  }),
  res: z.object({ ticketId: TicketIdSchema, key: TicketKeySchema }),
});

/** Every field a ticketUpdate may patch. null clears a nullable field. */
export const TicketPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: RichTextDocSchema.nullable(),
    stageId: z.string().min(1),
    priorityId: z.string().min(1).nullable(),
    tagIds: z.array(z.string().min(1)),
    assigneeUids: z.array(PrincipalIdSchema),
    startAt: MillisSchema.nullable(),
    dueAt: MillisSchema.nullable(),
    dueAllDay: z.boolean(),
    estimate: z.number().nonnegative().nullable(),
    /** Per person; null removes that person's commitment. Merged, not replaced. */
    commitments: z.record(UidSchema, MillisSchema.nullable()),
    /** FieldDef.id → value; merged per field (null clears). */
    fields: z.record(z.string(), FieldValueSchema),
    /** The full new list of this ticket's links; the inverse is written on the other ticket. */
    links: z.array(TicketLinkSchema),
  })
  .partial()
  .strict();
export type TicketPatch = z.infer<typeof TicketPatchSchema>;

/**
 * The token scopes a ticketUpdate patch needs — ALL of them (agents.html §E):
 * stageId → tickets:move, assigneeUids → tickets:assign, anything else →
 * tickets:update. An empty patch needs nothing beyond the command gate.
 */
export function patchScopes(patch: TicketPatch): Scope[] {
  const out = new Set<Scope>();
  for (const k of Object.keys(patch) as (keyof TicketPatch)[]) {
    if (patch[k] === undefined) continue;
    out.add(
      k === 'stageId' ? 'tickets:move' : k === 'assigneeUids' ? 'tickets:assign' : 'tickets:update',
    );
  }
  return [...out];
}

export const ticketUpdate = defineCommand({
  name: 'ticketUpdate',
  source: 'app',
  scopes: ['tickets:update', 'tickets:move', 'tickets:assign'],
  permission:
    "state must be 'active' (409). Only stageId(+rank) changing and !can(edit) → can(move, to) via StageGrant; otherwise can(edit); assigneeUids → can(assign). A token needs every scope patchScopes(patch) names.",
  errors: ['forbidden', 'not_found', 'conflict', 'unprocessable'],
  req: req({
    ...TicketRef,
    patch: TicketPatchSchema,
    /** Drag & drop: place between these neighbours in the (target) column. */
    rank: z
      .object({ after: TicketIdSchema.optional(), before: TicketIdSchema.optional() })
      .strict()
      .optional(),
    /** Optimistic concurrency for title/description: stale → 409 with { current }. */
    ifUpdatedAt: MillisSchema.optional(),
  }),
  res: z.object({ ok: z.literal(true), updatedAt: MillisSchema }),
});

export const BulkActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stage'), stageId: z.string().min(1) }),
  z.object({ type: z.literal('priority'), priorityId: z.string().min(1).nullable() }),
  z.object({ type: z.literal('due'), dueAt: MillisSchema.nullable() }),
  z.object({ type: z.literal('addTag'), tagId: z.string().min(1) }),
  z.object({ type: z.literal('addAssignee'), uid: PrincipalIdSchema }),
  z.object({ type: z.literal('state'), state: TicketStateSchema }),
  z.object({ type: z.literal('field'), fieldId: z.string().min(1), value: FieldValueSchema }),
]);
export type BulkAction = z.infer<typeof BulkActionSchema>;

/** The token scope one bulk action needs. */
export function bulkActionScope(action: BulkAction): Scope {
  switch (action.type) {
    case 'stage':
      return 'tickets:move';
    case 'addAssignee':
      return 'tickets:assign';
    case 'state':
      return 'tickets:state';
    default:
      return 'tickets:update';
  }
}

export const ticketBulk = defineCommand({
  name: 'ticketBulk',
  source: 'app',
  scopes: ['tickets:update', 'tickets:move', 'tickets:assign', 'tickets:state'],
  permission:
    "Role resolved once. Editor+: any action. A commenter may only run 'stage', over tickets their grant covers — the rest are SKIPPED, not failed.",
  errors: ['forbidden', 'not_found'],
  req: req({
    boardId: BoardIdSchema,
    ticketIds: z.array(TicketIdSchema).min(1).max(MAX_BULK_TICKETS),
    action: BulkActionSchema,
  }),
  res: z.object({ updated: z.number().int().nonnegative(), skipped: z.array(TicketIdSchema) }),
});

export const ticketState = defineCommand({
  name: 'ticketState',
  source: 'app',
  scopes: ['tickets:state'],
  permission: 'active → archived: can(state). archived → active: can(restore) = admin.',
  errors: ['forbidden', 'not_found', 'conflict'],
  // Phase 6: no `reason` — a reason recorded on a ticket nobody can see is
  // pointless, and the permanent option (ticketDelete) asks for one confirm.
  req: req({ ...TicketRef, state: TicketStateSchema }),
  res: OkResSchema,
});

export const ticketDelete = defineCommand({
  name: 'ticketDelete',
  // MCP (the Claude app as the whole UI): reachable by a token with these scopes.
  scopes: ['tickets:state'],
  source: 'app',
  permission: 'board.settings.allowDelete && can(delete). The key is tombstoned, never reissued.',
  errors: ['forbidden', 'not_found'],
  req: req(TicketRef),
  res: OkResSchema,
});

export const messagePost = defineCommand({
  name: 'messagePost',
  source: 'app',
  scopes: ['comments:write'],
  permission: "can(comment); ticket state == 'active' (closed tickets have closed threads → 409).",
  errors: ['forbidden', 'not_found', 'conflict', 'too_large'],
  req: z
    .object({
      ...TicketRef,
      body: RichTextDocSchema,
      /**
       * Phase 2: the Markdown source, when the door received Markdown (REST /
       * MCP). The door ALSO converts it to `body` (markdownToDoc, resolving
       * mentions); the thread renders this as GFM. Stored as Message.markdown.
       */
      markdown: z.string().max(100_000).optional(),
      /** Quoted message id — one level. */
      replyTo: z.string().min(1).optional(),
      /** Storage paths under this ticket's prefix (the app's direct uploads). */
      attachments: z.array(StoragePathSchema).max(MAX_ATTACHMENTS_PER_CALL).optional(),
      /**
       * Phase 2: ids of files ALREADY on this ticket (files/{fileId}, e.g. from
       * POST /v1/tickets/{KEY}/files or MCP upload_file) to attach to this message.
       * attachments + fileIds together ≤ MAX_ATTACHMENTS_PER_CALL. A message may
       * carry files and an empty body (the handler requires one or the other).
       */
      fileIds: z.array(z.string().min(1).max(128)).max(MAX_ATTACHMENTS_PER_CALL).optional(),
      /**
       * memory.html §E: memory files to attach BY REFERENCE (no upload). The
       * memory must be granted to this board; each becomes a ticket.files row
       * with source 'memory'.
       */
      memoryRefs: z.array(MemoryRefSchema).max(MEMORY_REFS_MAX).optional(),
      /** memory.html §J: files just uploaded into a memory (see ticketCreate.memoryUploads). */
      memoryUploads: z.array(MemoryUploadSchema).max(MAX_ATTACHMENTS_PER_CALL).optional(),
      /**
       * Phase 17 (agents.html §Y1): the TURN RECEIPT an orchestrator posts when
       * one run of an agent ends. Stored on the message, and in the SAME
       * transaction added to the ticket's, the board's and the day's cost
       * counters (§Y2). Only tokens send it (REST / MCP / SDK); the app's
       * composer never does. The message stays a 'comment'.
       */
      run: RunReceiptSchema.nullable().optional(),
      /** REQUIRED here: the optimistic bubble's id; a retried post is one message. */
      clientId: ClientIdSchema,
    })
    .strict()
    .refine(
      (r) =>
        (r.attachments?.length ?? 0) +
          (r.fileIds?.length ?? 0) +
          (r.memoryUploads?.length ?? 0) <=
        MAX_ATTACHMENTS_PER_CALL,
      {
        message: `At most ${MAX_ATTACHMENTS_PER_CALL} files per message`,
        path: ['fileIds'],
      },
    ),
  res: z.object({ messageId: z.string() }),
});

export const messageEdit = defineCommand({
  name: 'messageEdit',
  source: 'app',
  scopes: ['comments:write'],
  permission:
    'Author only for edit. Delete: the author or a board admin (admins may delete, not edit).',
  errors: ['forbidden', 'not_found', 'conflict'],
  req: req({
    ...TicketRef,
    messageId: z.string().min(1),
    body: RichTextDocSchema.optional(),
    delete: z.literal(true).optional(),
  }).refine((r) => (r.body === undefined) !== (r.delete === undefined), {
    message: 'Exactly one of body or delete',
  }),
  res: OkResSchema,
});

export const messagePin = defineCommand({
  name: 'messagePin',
  source: 'app',
  scopes: ['comments:write'],
  permission: 'can(pin) = editor+.',
  errors: ['forbidden', 'not_found'],
  req: req({ ...TicketRef, messageId: z.string().min(1), pinned: z.boolean() }),
  res: OkResSchema,
});

export const messageReact = defineCommand({
  name: 'messageReact',
  source: 'app',
  scopes: ['comments:write'],
  permission: 'can(comment). No notification.',
  errors: ['forbidden', 'not_found'],
  req: req({
    ...TicketRef,
    messageId: z.string().min(1),
    emoji: z.string().min(1).max(32),
    on: z.boolean(),
  }),
  res: OkResSchema,
});

export const ticketWatch = defineCommand({
  name: 'ticketWatch',
  source: 'app',
  scopes: ['tickets:read'],
  permission: 'can(read). Overrides a muted board.',
  errors: ['forbidden', 'not_found'],
  req: req({ ...TicketRef, watching: z.boolean() }),
  res: OkResSchema,
});

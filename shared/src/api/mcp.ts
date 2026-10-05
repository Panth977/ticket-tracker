/**
 * MCP tool input schemas — phase 2 (docs/plan/agents.html §G).
 *
 * The same token as REST works as a Bearer token on /mcp (OAuth still works
 * for interactive clients). Tools the credential's scopes don't allow are
 * HIDDEN from tools/list and refused if called (mcpToolAllowed).
 *
 * Exported as RAW SHAPES because the MCP SDK's server.tool(name, shape, …)
 * takes a ZodRawShape; McpToolSchemas wraps each with z.object(shape).strict().
 * There is deliberately no tool that deletes a TICKET (delete_tasklist only
 * removes a checklist).
 *
 * `board` (a board key) is optional on every tool that needs one. It is only
 * REQUIRED when the credential spans several boards — an OAuth grant, or
 * PHASE 10's ACCOUNT TOKEN (§R2) — and the call does not already name a
 * ticket key (a key names its board). A board token implies its board, so it
 * may leave `board` out exactly as before. With an account token list_boards
 * is the natural first call.
 */
import { z } from 'zod';
import type { Scope } from '../types/index.js';
import { MAX_ACK_IDS } from '../commands/agents.js';
import {
  PublicMemoryFileRefSchema,
  PublicQuestionFieldSchema,
  PublicRunReceiptSchema,
} from './public.js';
import { MAX_QUESTION_FIELDS, QUESTION_TITLE_MAX } from '../schema/question.js';
import {
  MAX_TASKLIST_ITEMS,
  TASK_ITEM_NOTE_MAX,
  TASK_ITEM_TITLE_MAX,
  TASKLIST_TITLE_MAX,
  TaskItemStatusSchema,
} from '../schema/tasklist.js';
import { AGENT_STATUS_MESSAGE_MAX, AgentStateSchema } from '../schema/agentStatus.js';
import {
  ARTIFACT_BUILD_MAX_FILES,
  ARTIFACT_DESCRIPTION_MAX,
  ARTIFACT_NAME_MAX,
  ArtifactAgentAccessSchema,
  ArtifactShareRoleSchema,
} from '../artifacts/schema.js';
import {
  ARTIFACT_DATA_BATCH_MAX,
  ARTIFACT_DATA_WHERE_MAX,
  ArtifactDataWhereSchema,
  ArtifactDataWriteSchema,
} from '../artifacts/data.js';
import { LIST_LIMIT_MAX } from '../artifacts/driver.js';

const Key = z.string().min(1).describe("Ticket key, e.g. 'ENG-42'");
const Board = z
  .string()
  .describe(
    "Board key, e.g. 'ENG'. Required when your token is account-wide (call list_boards first); " +
      'optional — and only ever your own board — when your token is scoped to one board.',
  );
const Principal = z.string().describe("A member: 'me', an id, an email, or an agent's name");
const IsoOrDate = z
  .string()
  .describe("ISO date or datetime, e.g. '2026-09-24' or '2026-09-24T17:00:00Z'");
const StageRef = z.string().describe('Stage name or id');
const FileIds = z
  .array(z.string().min(1))
  .max(20)
  .describe('File ids from upload_file, already on this ticket');
const Cursor = z.string().describe('Opaque cursor from a previous call');
const ArtifactRef = z
  .string()
  .min(1)
  .describe('Artifact id, from artifact_list or artifact_create');

const DataDocPath = z
  .string()
  .min(1)
  .max(1024)
  .describe(
    "A DOCUMENT path in the artifact's own view, e.g. 'scores/2026' (collection/doc[/collection/doc…])",
  );

export const McpToolShapes = {
  whoami: {},
  list_boards: {},
  get_board: { board: Board.optional() },
  list_my_tickets: {
    board: Board.optional(),
    stage: StageRef.optional(),
    state: z.enum(['active', 'archived']).optional().describe("Default 'active'"),
    updated_since: IsoOrDate.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  search_tickets: {
    query: z.string().optional(),
    board: Board.optional(),
    assignee: Principal.optional(),
    stage: StageRef.optional(),
    state: z.enum(['active', 'archived']).optional(),
    due_before: IsoOrDate.optional(),
    updated_since: IsoOrDate.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  get_ticket: {
    key: Key,
    messages: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Also return the last N messages (default 20)'),
  },
  get_messages: {
    key: Key,
    cursor: Cursor.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  create_ticket: {
    board: Board.optional(),
    title: z.string().min(1).max(500),
    description: z
      .string()
      .max(100_000)
      .optional()
      .describe('Markdown; mention people as @email, agents as @ag_…, tickets as #KEY'),
    assignees: z.array(Principal).optional(),
    due: IsoOrDate.optional(),
    priority: z.string().optional().describe('Priority name'),
    stage: StageRef.optional(),
    tags: z.array(z.string()).optional(),
    fields: z.record(z.string(), z.unknown()).optional().describe('Custom fields by NAME'),
  },
  update_ticket: {
    key: Key,
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(100_000).optional().describe('Markdown; replaces the description'),
    stage: StageRef.optional(),
    assignees: z
      .array(Principal)
      .optional()
      .describe('Replaces the list; see assign_ticket to add / remove'),
    due: IsoOrDate.nullable().optional(),
    priority: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
  },
  move_ticket: { key: Key, stage: StageRef },
  assign_ticket: {
    key: Key,
    add: z.array(Principal).max(50).optional(),
    remove: z.array(Principal).max(50).optional(),
  },
  post_message: {
    key: Key,
    markdown: z
      .string()
      .max(100_000)
      .describe('GitHub-flavoured Markdown. May be empty when attachments are given.'),
    attachments: FileIds.optional(),
    memory_files: z
      .array(PublicMemoryFileRefSchema)
      .max(20)
      .optional()
      .describe(
        'Memory files to attach by reference (no upload): [{ memory_id, path }] or [{ memory_id, node_id }]. The memory must be granted to this board (memory_list board=…).',
      ),
    reply_to: z.string().min(1).optional().describe('Message id to quote'),
    run: PublicRunReceiptSchema.nullable()
      .optional()
      .describe(
        'Orchestrators only: the turn receipt for one finished run of the agent — { n, outcome, cost_usd, ' +
          'session_usd, duration_ms, api_turns, model, usage }. Added to the ticket, board and day cost counters.',
      ),
  },
  upload_file: {
    key: Key,
    name: z
      .string()
      .min(1)
      .max(255)
      .describe("File name with extension, e.g. 'plan.md', 'report.html'"),
    mime: z.string().optional().describe('Default: from the extension'),
    text: z
      .string()
      .optional()
      .describe('Text content (Markdown, HTML, CSV, code …). Give text OR content_base64.'),
    content_base64: z.string().optional().describe('Binary content, base64. ≤ 25 MB decoded.'),
  },
  read_file: { fileId: z.string().min(1) },
  link_tickets: { from: Key, to: Key, type: z.enum(['blocks', 'relates', 'duplicates']) },
  get_events: {
    cursor: Cursor.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  ack_events: {
    ids: z.array(z.string().min(1)).min(1).max(MAX_ACK_IDS).optional(),
    upTo: z
      .string()
      .min(1)
      .optional()
      .describe('Ack everything up to and including this event id / cursor'),
  },
  // ───────── phase 3 (§L1–L4) ─────────
  ask_question: {
    key: Key,
    title: z
      .string()
      .min(1)
      .max(QUESTION_TITLE_MAX)
      .describe("What you need to know, e.g. 'Which database should the report use?'"),
    body: z.string().max(100_000).optional().describe('Markdown context shown under the title'),
    fields: z
      .array(PublicQuestionFieldSchema)
      .min(1)
      .max(MAX_QUESTION_FIELDS)
      .describe(
        "1–10 form fields: { id, label, type: 'single'|'multi'|'text'|'longText'|'number'|'boolean'|'date', options?, required?, default?, placeholder? }",
      ),
    allow_comment: z.boolean().optional().describe("Adds an 'Anything else?' box"),
    to: z
      .array(Principal)
      .max(50)
      .optional()
      .describe('Who should answer; omit to ask anyone on the board'),
    blocking: z
      .boolean()
      .optional()
      .describe("Default true: the ticket shows 'Waiting for your answer'"),
    expires_at: IsoOrDate.optional().describe('After this the card locks as Expired'),
  },
  get_question: { id: z.string().min(1).describe('The question id returned by ask_question') },
  cancel_question: { id: z.string().min(1) },
  set_tasklist: {
    key: Key,
    title: z
      .string()
      .min(1)
      .max(TASKLIST_TITLE_MAX)
      .describe("Your plan's name, e.g. 'Plan: add CSV export'"),
    items: z
      .array(
        z.object({
          id: z
            .string()
            .min(1)
            .max(64)
            .optional()
            .describe('Keep an id to keep that item across a replace'),
          title: z.string().min(1).max(TASK_ITEM_TITLE_MAX),
          status: TaskItemStatusSchema.optional().describe("Default 'todo'"),
          note: z.string().max(TASK_ITEM_NOTE_MAX).optional(),
        }),
      )
      .max(MAX_TASKLIST_ITEMS)
      .describe('The whole list — this replaces what is there'),
    list_id: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Omit to create a new list; give it to replace that one'),
    position: z.number().optional(),
    closed: z.boolean().optional().describe('true when the plan is finished'),
  },
  update_task_item: {
    key: Key,
    list_id: z.string().min(1).max(64),
    item_id: z.string().min(1).max(64),
    status: TaskItemStatusSchema.optional(),
    note: z
      .string()
      .max(TASK_ITEM_NOTE_MAX)
      .nullable()
      .optional()
      .describe('Why it failed, what was skipped'),
  },
  delete_tasklist: { key: Key, list_id: z.string().min(1).max(64) },
  heartbeat: {
    ticket: Key.optional().describe('Omit for an agent-level beat, about no ticket in particular'),
    state: AgentStateSchema.describe(
      "'working' every minute while you work; 'idle', 'done' or 'error' when you stop",
    ),
    message: z.string().max(AGENT_STATUS_MESSAGE_MAX).optional().describe("'Running tests (3/12)'"),
    progress: z.number().min(0).max(1).optional(),
    board: Board.optional(),
  },
  // ───────── artifacts (docs/plan/artifacts.html §C2) ─────────
  artifact_list: {},
  artifact_get: { id: ArtifactRef },
  artifact_create: {
    name: z.string().min(1).max(ARTIFACT_NAME_MAX),
    description: z.string().max(ARTIFACT_DESCRIPTION_MAX).optional(),
    icon: z.string().max(16).optional().describe('One emoji'),
  },
  artifact_publish: {
    id: ArtifactRef,
    files: z
      .array(
        z.object({
          path: z
            .string()
            .min(1)
            .max(1024)
            .describe("Relative to the build root, e.g. 'index.html', 'assets/app.js'"),
          content: z.string(),
          encoding: z
            .enum(['utf8', 'base64'])
            .optional()
            .describe("Default 'utf8'; 'base64' for images and other binaries"),
        }),
      )
      .min(1)
      .max(ARTIFACT_BUILD_MAX_FILES)
      .describe(
        'The WHOLE build, not a patch: every file of the site, with an index.html at its root. At most 5 MB in one call. ' +
          'Load assets by RELATIVE paths (./app.js), never /app.js.',
      ),
    message: z.string().max(500).optional().describe('A line saying what changed'),
  },
  artifact_rollback: {
    id: ArtifactRef,
    build: z.string().min(1).describe('A build id from artifact_get'),
  },
  artifact_share: {
    id: ArtifactRef,
    email: z.string().optional().describe('A person. Give email OR agent.'),
    agent: z
      .string()
      .optional()
      .describe("One of the owner's agents ('ag_…'); say what it may do with agent_access"),
    role: ArtifactShareRoleSchema.nullable()
      .optional()
      .describe(
        "A person: 'editor', 'viewer', or null to remove. An agent: leave out and give agent_access (or 'editor' = build + write data, null = remove).",
      ),
    agent_access: ArtifactAgentAccessSchema.optional().describe(
      "Agents only: { build: true|false, data: 'none'|'read'|'write' }. build = publish, roll back, source; data = its database and files. Both off removes the agent.",
    ),
  },
  artifact_source: {
    id: ArtifactRef,
    build: z.string().min(1).optional().describe('Default: the newest build that has a source zip'),
  },
  // ───────── artifact data (docs/plan/agents.html §AA4) — Firestore only ─────────
  artifact_data_get: { id: ArtifactRef, path: DataDocPath },
  artifact_data_list: {
    id: ArtifactRef,
    path: z
      .string()
      .min(1)
      .max(1024)
      .describe("A COLLECTION path in the artifact's own view: 'scores', 'scores/2026/entries'"),
    where: z
      .array(ArtifactDataWhereSchema)
      .max(ARTIFACT_DATA_WHERE_MAX)
      .optional()
      .describe(
        "Filters, each [field, op, value]; op is one of < <= == != >= > array-contains in not-in array-contains-any. e.g. [['status','==','open']]",
      ),
    order_by: z.string().min(1).max(600).optional().describe("'field' or 'field,desc'"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIST_LIMIT_MAX)
      .optional()
      .describe('Default 100, at most 500'),
    start_after: z
      .string()
      .min(1)
      .optional()
      .describe("A document id: the previous page's next_cursor"),
  },
  artifact_data_set: {
    id: ArtifactRef,
    path: DataDocPath,
    data: z
      .record(z.string(), z.unknown())
      .describe(
        'The document, as JSON. A timestamp is { "$date": "2026-09-30T05:30:00Z" }; the server\'s clock is { "$serverTime": true }.',
      ),
    merge: z
      .boolean()
      .optional()
      .describe('true merges into the stored document instead of replacing it'),
  },
  artifact_data_batch: {
    id: ArtifactRef,
    writes: z
      .array(ArtifactDataWriteSchema)
      .min(1)
      .max(ARTIFACT_DATA_BATCH_MAX)
      .describe(
        "Up to 400 writes applied ALL OR NOTHING: { op: 'set', path, data, merge? } | { op: 'update', path, data } | { op: 'delete', path }. How a job replaces a dataset.",
      ),
  },
} as const satisfies Record<string, z.ZodRawShape>;

export type McpToolName = keyof typeof McpToolShapes;
export type McpToolInput<N extends McpToolName> = z.infer<z.ZodObject<(typeof McpToolShapes)[N]>>;

export interface McpToolMeta {
  description: string;
  readOnly: boolean;
  /** The credential needs ANY of these for the tool to be listed / callable. [] = any credential. */
  scopes: readonly Scope[];
}

export const MCP_TOOLS: Record<McpToolName, McpToolMeta> = {
  whoami: {
    description:
      'Who you are: principal, board, scopes — and, for an agent, its name, description and system prompt.',
    readOnly: true,
    scopes: [],
  },
  list_boards: {
    description:
      'Boards this credential may act on. With an account-wide token this is the natural FIRST call: it lists every board ' +
      'you are on right now, and their keys are what the `board` argument takes.',
    readOnly: true,
    scopes: ['board:read'],
  },
  get_board: {
    description:
      'The board: stages (with categories), priorities, tags, custom fields, and members (people and agents).',
    readOnly: true,
    scopes: ['board:read'],
  },
  list_my_tickets: {
    description: 'Tickets assigned to you, most recently updated first.',
    readOnly: true,
    scopes: ['tickets:read'],
  },
  search_tickets: {
    description: 'Find tickets by text, assignee, stage, state or dates.',
    readOnly: true,
    scopes: ['tickets:read'],
  },
  get_ticket: {
    description:
      'A ticket with fields, links, pinned messages, files and its last messages (Markdown).',
    readOnly: true,
    scopes: ['tickets:read'],
  },
  get_messages: {
    description: "Page through a ticket's thread (Markdown bodies, attachments with file ids).",
    readOnly: true,
    scopes: ['comments:read'],
  },
  create_ticket: { description: 'Create a ticket.', readOnly: false, scopes: ['tickets:create'] },
  update_ticket: {
    description:
      'Change a ticket: title, description, stage, assignees, due date, priority, tags, fields.',
    readOnly: false,
    scopes: ['tickets:update', 'tickets:move', 'tickets:assign'],
  },
  move_ticket: {
    description: 'Move a ticket to another stage.',
    readOnly: false,
    scopes: ['tickets:move'],
  },
  assign_ticket: {
    description: 'Add or remove assignees (people or agents).',
    readOnly: false,
    scopes: ['tickets:assign'],
  },
  post_message: {
    description:
      "Post a Markdown message in a ticket's thread, optionally with files from upload_file or memory_files (memory files by reference). An orchestrator may attach `run`, the receipt of one finished run (cost, outcome, duration).",
    readOnly: false,
    scopes: ['comments:write'],
  },
  upload_file: {
    description:
      'Put a file on a ticket and get its fileId. Pass `text` for Markdown / HTML documents, or content_base64.',
    readOnly: false,
    scopes: ['files:write'],
  },
  read_file: {
    description:
      'Read a file: the text for Markdown, HTML, text, CSV, JSON and code; a short-lived download URL otherwise.',
    readOnly: true,
    scopes: ['files:read'],
  },
  link_tickets: {
    description: 'Link two tickets: blocks, relates or duplicates.',
    readOnly: false,
    scopes: ['tickets:update'],
  },
  get_events: {
    description:
      'Your inbox: assignments, mentions, comments and changes on your tickets since a cursor.',
    readOnly: true,
    scopes: ['events:read'],
  },
  ack_events: {
    description: 'Acknowledge inbox events by id, or everything up to a cursor.',
    readOnly: false,
    scopes: ['events:read'],
  },
  // phase 3 (§L)
  ask_question: {
    description:
      'Ask the people on a ticket a question with options. It appears in the thread as a form card; the answer comes back as the inbox event question_answered.',
    readOnly: false,
    scopes: ['questions:write'],
  },
  get_question: {
    description: 'A question you asked: its status and, once given, the answer values.',
    readOnly: true,
    scopes: ['comments:read'],
  },
  cancel_question: {
    description: 'Cancel a question you asked — the card locks and nobody is chased for it.',
    readOnly: false,
    scopes: ['questions:write'],
  },
  set_tasklist: {
    description:
      'Publish your plan as a checklist on the ticket (create or replace the whole list).',
    readOnly: false,
    scopes: ['tasklists:write'],
  },
  update_task_item: {
    description:
      'Tick one item off, start it, or mark it failed with a note. Cheap — call it as you work.',
    readOnly: false,
    scopes: ['tasklists:write'],
  },
  delete_tasklist: {
    description: 'Remove a task list from the ticket.',
    readOnly: false,
    scopes: ['tasklists:write'],
  },
  heartbeat: {
    description:
      "Say what you are doing: every minute while you work, and once more when you stop ('done' or 'error'). People see a live dot on the ticket.",
    readOnly: false,
    scopes: ['status:write'],
  },
  // artifacts (§C2, §C4)
  artifact_list: {
    description:
      'The artifacts you can reach: small websites kept inside TaskManager, each with its own people and data.',
    readOnly: true,
    scopes: ['artifacts:read', 'artifacts:write'],
  },
  artifact_get: {
    description:
      'One artifact: its meta, its kept builds (newest first) and who it is shared with.',
    readOnly: true,
    scopes: ['artifacts:read', 'artifacts:write'],
  },
  artifact_create: {
    description:
      'Create an empty artifact, then publish a build into it with artifact_publish. With an account-wide credential you become its owner; as an agent, your owner owns it (it appears in their sidebar at once) and you may build it and write its data.',
    readOnly: false,
    scopes: ['artifacts:write'],
  },
  artifact_publish: {
    description:
      'Publish a build from files: [{ path, content, encoding }]. It becomes the current build at once. For a hand-written HTML/CSS/JS artifact; a framework build (a dist/ folder) goes through the SDK or REST as a zip. The page gets its backend from a script tag loading /backend-driver/v1/driver.js from the TaskManager app origin (window.BackendDriver).',
    readOnly: false,
    scopes: ['artifacts:write'],
  },
  artifact_rollback: {
    description: 'Make a kept build the current one (roll back, or forward again).',
    readOnly: false,
    scopes: ['artifacts:write'],
  },
  artifact_share: {
    description:
      'Owner only (never an agent): share an artifact with a person (by email) or one of your agents, change what they may do, or remove them. A person without an account yet is invited.',
    readOnly: false,
    scopes: ['artifacts:write'],
  },
  artifact_source: {
    description:
      'A short-lived download URL for the source zip that was published beside a build — what you need to carry on where the last author stopped.',
    readOnly: true,
    scopes: ['artifacts:read', 'artifacts:write'],
  },
  // artifact data (agents.html §AA4) — the artifact's own Firestore, from outside the page.
  artifact_data_get: {
    description:
      "Read one document of an artifact's own database. Needs data access on the artifact (an agent: data 'read' or 'write'; a person: owner or editor). Timestamps come back as { \"$date\": ISO }.",
    readOnly: true,
    scopes: ['artifacts:read', 'artifacts:write'],
  },
  artifact_data_list: {
    description:
      "List a collection of an artifact's own database, with optional filters, ordering and paging (next_cursor → start_after).",
    readOnly: true,
    scopes: ['artifacts:read', 'artifacts:write'],
  },
  artifact_data_set: {
    description:
      "Write one document of an artifact's own database (replace, or merge). Needs data 'write' on the artifact. The page reads the same documents through its driver, live.",
    readOnly: false,
    scopes: ['artifacts:write'],
  },
  artifact_data_batch: {
    description:
      "Apply up to 400 set / update / delete writes to an artifact's own database atomically — all of them or none.",
    readOnly: false,
    scopes: ['artifacts:write'],
  },
};

/** Cross-field rules the raw shapes cannot say (applied by McpToolSchemas). */
const REFINES: Partial<Record<McpToolName, (v: Record<string, unknown>) => string | null>> = {
  upload_file: (v) =>
    (v.text === undefined) !== (v.content_base64 === undefined)
      ? null
      : 'Give exactly one of text or content_base64',
  ack_events: (v) =>
    (v.ids === undefined) !== (v.upTo === undefined) ? null : 'Give exactly one of ids or upTo',
  assign_ticket: (v) =>
    ((v.add as unknown[] | undefined)?.length ?? 0) +
      ((v.remove as unknown[] | undefined)?.length ?? 0) >
    0
      ? null
      : 'Nothing to add or remove',
  update_task_item: (v) =>
    v.status !== undefined || v.note !== undefined ? null : 'Give a status or a note',
  artifact_share: (v) =>
    (v.email === undefined) === (v.agent === undefined)
      ? 'Give exactly one of email or agent'
      : v.role === undefined && (v.agent === undefined || v.agent_access === undefined)
        ? 'Give role — or, for an agent, agent_access'
        : v.email !== undefined && v.agent_access !== undefined
          ? 'agent_access is for an agent'
          : null,
  post_message: (v) =>
    String(v.markdown ?? '').trim().length > 0 ||
    ((v.attachments as unknown[] | undefined)?.length ?? 0) > 0
      ? null
      : 'A message needs markdown or attachments',
};

/** Full validators: z.object(shape).strict() plus the cross-field rules. */
export const McpToolSchemas = Object.fromEntries(
  Object.entries(McpToolShapes).map(([k, shape]) => {
    const base = z.object(shape as z.ZodRawShape).strict();
    const rule = REFINES[k as McpToolName];
    return [
      k,
      rule
        ? base.superRefine((v, ctx) => {
            const msg = rule(v as Record<string, unknown>);
            if (msg) ctx.addIssue({ code: 'custom', message: msg });
          })
        : base,
    ];
  }),
) as unknown as { [N in McpToolName]: z.ZodType<McpToolInput<N>, z.ZodTypeDef, unknown> };

/** Is this tool listed / callable for a credential with these scopes? (absent = full session) */
export function mcpToolAllowed(
  name: McpToolName,
  scopes: readonly Scope[] | undefined | null,
): boolean {
  const need = MCP_TOOLS[name].scopes;
  return !scopes || need.length === 0 || need.some((s) => scopes.includes(s));
}

/** Resource URI templates. */
export const MCP_RESOURCES = {
  /** Markdown of the ticket including its thread. */
  ticket: 'ticket://{key}',
  /** A file's content (text kinds) or a link to it. */
  file: 'file://{fileId}',
  /** The token's board: stages, fields, members. */
  boardSchema: 'board://schema',
  /** A named board, for multi-board credentials. */
  boardSchemaByKey: 'board://{key}/schema',
} as const;
export const MCP_PROMPTS = ['triage_board', 'standup_summary'] as const;

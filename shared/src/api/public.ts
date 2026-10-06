/**
 * The shape the outside world sees (platform/backend.json proxyFunctions.toPublic).
 *
 * Ids are resolved to names so a script or a model can read it without a
 * second call; custom fields are keyed by NAME outside and by id inside.
 * RichText → Markdown: mentions as [@Name](mailto:email), refs as #KEY.
 * Keys are snake_case; times are ISO 8601 strings.
 *
 * Phase 2 (agents.html §A, §F): every person-shaped value is a PRINCIPAL and
 * carries `kind: 'user' | 'agent'`; agents have email ''. Files carry their
 * `kind` (fileKind) so a script knows whether read_file returns text.
 */
import { z } from 'zod';
import {
  PrincipalKindSchema,
  type NotifyEvent,
  StageCategorySchema,
  TicketStateSchema,
  ViaSchema,
} from '../types/index.js';
import type { AgentEventType } from '../schema/agent.js';
import { FileKindSchema } from '../logic/files.js';
import {
  QuestionFieldTypeSchema,
  QuestionStatusSchema,
  QuestionValueSchema,
} from '../schema/question.js';
import { TaskItemStatusSchema } from '../schema/tasklist.js';
import { AgentHealthSchema, AgentStateSchema } from '../schema/agentStatus.js';
import { MessageKindSchema } from '../schema/ticket.js';
import { RunOutcomeSchema } from '../schema/message.js';
import { AGG_ENTRIES_MAX, AggPeriodSchema } from '../schema/aggregates.js';
import { ArtifactAgentAccessSchema, ArtifactRoleSchema } from '../artifacts/schema.js';
import { IndicatorSchema } from '../types/indicator.js';

const Iso = z.string().datetime({ offset: true });

/** A principal as the outside world sees it: a person or an agent. */
export const PublicPersonSchema = z.object({
  id: z.string(),
  /** 'user' | 'agent' — agents' ids start with 'ag_'. */
  kind: PrincipalKindSchema,
  name: z.string(),
  /** '' for agents. */
  email: z.string(),
  avatar_url: z.string().nullable(),
  /** Agents: a prebuilt icon id (AGENT_ICON_IDS) shown when there is no picture; null for people. */
  icon: z.string().nullable(),
});
export type PublicPerson = z.infer<typeof PublicPersonSchema>;
/** Same shape; the phase-2 name. */
export const PublicPrincipalSchema = PublicPersonSchema;
export type PublicPrincipal = PublicPerson;

/** Who wrote something, compactly (messages, events). */
export const PublicActorSchema = z.object({
  id: z.string().nullable(),
  kind: PrincipalKindSchema.nullable(),
  name: z.string(),
});
export type PublicActor = z.infer<typeof PublicActorSchema>;

/**
 * Phase 17 (agents.html §Y2): what the agents' turns have cost — on a ticket
 * (every receipt ever posted on it) and on a board (its lifetime). null =
 * no receipt yet.
 */
export const PublicCostSchema = z.object({
  usd: z.number().nonnegative(),
  /** How many turn receipts were posted. */
  runs: z.number().int().nonnegative(),
});
export type PublicCost = z.infer<typeof PublicCostSchema>;

/**
 * Phase 17 (§Y1): the TURN RECEIPT — the same shape on the way in (POST
 * /v1/tickets/{KEY}/messages `run`, MCP post_message `run`) and on the way out
 * (PublicMessage.run). `cost_usd` is THIS turn; `session_usd` is the running
 * total Claude reports for the resumed session. Only an orchestrator posts
 * it; the thread renders the message as a compact receipt row.
 */
export const PublicRunReceiptSchema = z.object({
  /** The orchestrator's run counter on this ticket, 1-based. */
  n: z.number().int().positive(),
  outcome: RunOutcomeSchema,
  cost_usd: z.number().nonnegative(),
  session_usd: z.number().nonnegative().nullable(),
  duration_ms: z.number().int().nonnegative(),
  api_turns: z.number().int().nonnegative().nullable(),
  model: z.string().max(80).nullable(),
  usage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cache_read: z.number().int().nonnegative(),
      cache_write: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type PublicRunReceipt = z.infer<typeof PublicRunReceiptSchema>;

/**
 * aggregates.html: a board's AGGREGATE FIELD — a number its tickets add up
 * (Cost, Time…) with a unit and the period its totals are bucketed by.
 */
export const PublicAggFieldSchema = z.object({
  /** 'cost' (turn receipts land here) or 'a_xxxxxx'. Post entries by id or by label. */
  id: z.string(),
  label: z.string(),
  unit: z.string(),
  period: AggPeriodSchema,
  show_on_card: z.boolean(),
  /** Removed from the board: totals kept, no new entries. */
  archived: z.boolean(),
});
export type PublicAggField = z.infer<typeof PublicAggFieldSchema>;
/** Per field id: { total, count } (count = how many entries). */
export const PublicAggCountersSchema = z.record(
  z.string(),
  z.object({ total: z.number(), count: z.number().int().nonnegative() }),
);
export type PublicAggCounters = z.infer<typeof PublicAggCountersSchema>;
/** PublicMessage.agg — the entries a message added (kind 'agg', or a receipt's cost). */
export const PublicMessageAggSchema = z.object({
  /** ISO — the moment the entries are for (a backdated log); absent = when posted. */
  at: z.string().optional(),
  entries: z.array(z.object({ field_id: z.string(), value: z.number() })),
});
export type PublicMessageAgg = z.infer<typeof PublicMessageAggSchema>;
/**
 * The way IN (REST POST /v1/tickets/{KEY}/messages `agg`, MCP post_message
 * `agg`): each entry names its field by `field_id` or by `field` (the label,
 * case-insensitive). A negative value takes away.
 */
export const PublicAggInputSchema = z.object({
  /**
   * What the entries are FOR, when not now: a date ('2026-10-04' — that day),
   * an ISO date-time, or millis. A backfilled daily log lands in its own day's
   * bucket. Not in the future; at most 400 days back.
   */
  at: z.union([z.string().min(1).max(40), z.number()]).optional(),
  entries: z
    .array(
      z
        .object({
          field_id: z.string().min(1).max(40).optional(),
          field: z.string().min(1).max(40).optional(),
          value: z.number().finite(),
        })
        .refine((e) => (e.field_id === undefined) !== (e.field === undefined), {
          message: 'Name the field by exactly one of field_id or field',
        }),
    )
    .min(1)
    .max(AGG_ENTRIES_MAX),
});
export type PublicAggInput = z.infer<typeof PublicAggInputSchema>;
/** GET /v1/boards/{KEY}/aggregates, MCP get_aggregates: one field's period buckets. */
export const PublicAggBucketsSchema = z.object({
  field: PublicAggFieldSchema,
  /** Lifetime total of the field on the board. */
  total: z.object({ total: z.number(), count: z.number().int().nonnegative() }),
  /** Oldest first; only buckets with entries. `key` is '2026-10-05' | '2026-W40' | '2026-10'. */
  buckets: z.array(
    z.object({
      key: z.string(),
      total: z.number(),
      count: z.number().int().nonnegative(),
      /** Per ticket KEY. */
      tickets: PublicAggCountersSchema,
    }),
  ),
});
export type PublicAggBuckets = z.infer<typeof PublicAggBucketsSchema>;

/**
 * Phase 17 (§Z2): an agent profile as POST /v1/agents answers it — what an
 * account token needs to put the agent on a board and mint nothing else.
 */
export const PublicAgentSchema = z.object({
  /** 'ag_…' — pass it to POST /v1/boards/{KEY}/agents as `agent`. */
  id: z.string(),
  kind: z.literal('agent'),
  name: z.string(),
  description: z.string().nullable(),
  /** Markdown. */
  system_prompt: z.string(),
  avatar_url: z.string().nullable(),
  /** A prebuilt icon id (AGENT_ICON_IDS), or null. */
  icon: z.string().nullable(),
  archived: z.boolean(),
  created_at: Iso,
});
export type PublicAgent = z.infer<typeof PublicAgentSchema>;

export const PublicMemberSchema = PublicPersonSchema.extend({
  role: z.enum(['admin', 'editor', 'commenter', 'viewer']),
  /** Agents: their one-line description. */
  description: z.string().nullable().optional(),
  /** Commenters: the stages they may move tickets between (ids). */
  stage_grant: z
    .object({ stages: z.array(z.string()), assigned_only: z.boolean() })
    .nullable()
    .optional(),
});
export type PublicMember = z.infer<typeof PublicMemberSchema>;

/** A stage named on a ticket (or an intake form). */
export const PublicStageRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: StageCategorySchema,
});
/** A stage as a board lists it. */
export const PublicStageSchema = PublicStageRefSchema.extend({
  /**
   * indicators.html: what this stage MEANS, in the board admin's words — read
   * it to decide which stage a ticket belongs in. null = not written.
   */
  description: z.string().nullable(),
  /** indicators.html: the stage's mark (colour / icon / emoji / image). */
  indicator: IndicatorSchema,
});
export const PublicOptionSchema = z.object({ id: z.string(), name: z.string() });
export const PublicFieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  required: z.boolean(),
  /** select / multiSelect choices, by name. */
  options: z.array(z.string()).optional(),
});

export const PublicBoardRefSchema = z.object({ id: z.string(), key: z.string(), name: z.string() });

export const PublicBoardSchema = PublicBoardRefSchema.extend({
  url: z.string(),
  /** indicators.html: what the board is for (plain text, Markdown allowed). */
  description_md: z.string().nullable(),
  /** indicators.html: the board's mark. */
  indicator: IndicatorSchema,
  stages: z.array(PublicStageSchema),
  priorities: z.array(PublicOptionSchema),
  tags: z.array(PublicOptionSchema),
  fields: z.array(PublicFieldSchema),
  /** Present on GET /v1/boards/{key} and MCP list_boards; omitted in lists. */
  members: z.array(PublicMemberSchema).optional(),
  archived: z.boolean(),
  /** Phase 17 (§Y2): every turn receipt on every ticket, for the board's lifetime; null = none yet. */
  cost: PublicCostSchema.nullable(),
  /** aggregates.html: the board's aggregate fields (archived ones included, flagged). */
  agg_fields: z.array(PublicAggFieldSchema),
  /** aggregates.html: lifetime { total, count } per field id. */
  aggs: PublicAggCountersSchema,
});
export type PublicBoard = z.infer<typeof PublicBoardSchema>;

export const PublicTicketSchema = z.object({
  id: z.string(),
  key: z.string(),
  url: z.string(),
  title: z.string(),
  description_md: z.string().nullable(),
  board: PublicBoardRefSchema,
  stage: PublicStageRefSchema,
  priority: PublicOptionSchema.nullable(),
  /** Tag names. */
  tags: z.array(z.string()),
  assignees: z.array(PublicPersonSchema),
  start_at: Iso.nullable(),
  due_at: Iso.nullable(),
  due_all_day: z.boolean(),
  estimate: z.number().nullable(),
  /** Keyed by field NAME. */
  fields: z.record(z.string(), z.unknown()),
  links: z.array(z.object({ type: z.string(), key: z.string() })),
  /** Keys of tickets that #mention this one. */
  referenced_by: z.array(z.string()),
  state: TicketStateSchema,
  /** Phase 17 (§Y2): what the agents' turns on this ticket have cost; null = no receipt yet. */
  cost: PublicCostSchema.nullable(),
  /** aggregates.html: this ticket's { total, count } per aggregate field id. */
  aggs: PublicAggCountersSchema,
  created_at: Iso,
  updated_at: Iso,
});
export type PublicTicket = z.infer<typeof PublicTicketSchema>;

/** A file as a message lists it. `id` is the file id (files/{fileId}) — GET /v1/files/{id}. */
export const PublicAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  kind: FileKindSchema,
  /** Short-lived signed URL; absent when not resolved. */
  url: z.string().optional(),
});
export type PublicAttachment = z.infer<typeof PublicAttachmentSchema>;

/** GET /v1/files/{fileId}, POST /v1/tickets/{KEY}/files, MCP read_file / upload_file. */
export const PublicFileSchema = PublicAttachmentSchema.extend({
  ticket_key: z.string(),
  /** Syntax-highlighting guess for text-ish kinds. */
  language: z.string().nullable(),
  /** read_file / ?content=1 return the text inline. */
  textual: z.boolean(),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  /** Signed download URL (valid SIGNED_URL_TTL_MS) and when it stops working. */
  url: z.string().optional(),
  url_expires_at: Iso.optional(),
  /** The message it is attached to; null when only uploaded (source 'upload') or on the description. */
  message_id: z.string().nullable(),
  source: z.enum(['description', 'message', 'upload', 'memory']),
  /** memory.html §E: a reference to a memory file — its bytes are the node's current version. */
  memory: z.object({ memory_id: z.string(), node_id: z.string() }).optional(),
  uploaded_by: PublicActorSchema,
  created_at: Iso,
});
export type PublicFile = z.infer<typeof PublicFileSchema>;

// ───────────────────────── phase 3: questions (§L1) ─────────────────────────

/**
 * A question's field as the API states it — the stored shape with nothing
 * renamed: ids and labels are the asker's own words, so a script can echo them
 * back as the answer's keys.
 */
export const PublicQuestionFieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: QuestionFieldTypeSchema,
  options: z
    .array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() }))
    .optional(),
  required: z.boolean().optional(),
  default: QuestionValueSchema.optional(),
  placeholder: z.string().optional(),
});
export type PublicQuestionField = z.infer<typeof PublicQuestionFieldSchema>;

/** GET /v1/questions/{id}, POST …/questions, MCP ask_question / get_question. */
export const PublicQuestionSchema = z.object({
  /** questionId(ticketId, messageId) — pass it to GET / cancel. */
  id: z.string(),
  ticket_key: z.string(),
  /** Where the card sits in the thread. */
  message_id: z.string(),
  title: z.string(),
  /** The optional context, as Markdown. */
  body_md: z.string().nullable(),
  fields: z.array(PublicQuestionFieldSchema),
  allow_comment: z.boolean(),
  /** Who should answer; null = anyone on the board who may comment. */
  to: z.array(PublicPersonSchema).nullable(),
  blocking: z.boolean(),
  /** Already 'expired' once expires_at has passed, whatever is stored. */
  status: QuestionStatusSchema,
  expires_at: Iso.nullable(),
  asked_by: PublicActorSchema,
  created_at: Iso,
  /** null until somebody submits. `values` is keyed by FIELD ID. */
  answer: z
    .object({
      values: z.record(z.string(), QuestionValueSchema),
      comment: z.string().nullable(),
      by: PublicActorSchema,
      at: Iso,
    })
    .nullable(),
});
export type PublicQuestion = z.infer<typeof PublicQuestionSchema>;

export const PublicMessageSchema = z.object({
  id: z.string(),
  ticket_key: z.string(),
  kind: MessageKindSchema,
  body_md: z.string(),
  /** kind 'question' (§L1): the form card, its status and the answer. */
  question: PublicQuestionSchema.nullable().optional(),
  author: PublicActorSchema,
  via: ViaSchema,
  /** 'orch-eng-builder' when a token posted it ('Builder (agent) via token orch-eng-builder'). */
  via_token: z.string().nullable(),
  reply_to: z.string().nullable(),
  attachments: z.array(PublicAttachmentSchema),
  reactions: z.record(z.string(), z.number()),
  pinned: z.boolean(),
  /** Phase 17 (§Y1): the turn receipt, when this message is one; null otherwise. */
  run: PublicRunReceiptSchema.nullable(),
  /** aggregates.html: the entries this message added (kind 'agg', or a receipt's cost); null otherwise. */
  agg: PublicMessageAggSchema.nullable(),
  created_at: Iso,
  edited_at: Iso.nullable(),
  deleted: z.boolean(),
});
export type PublicMessage = z.infer<typeof PublicMessageSchema>;

/** Millis → ISO (null-safe) — the one conversion every toPublic does. */
export const toIso = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

/**
 * GET /v1/tickets/{KEY}, MCP get_ticket: the ticket plus what an agent needs
 * to start work — watchers, pinned messages, files, and (when asked with
 * ?messages=N / { messages: N }) the last N messages, oldest first.
 */
export const PublicTicketDetailSchema = PublicTicketSchema.extend({
  watchers: z.array(PublicPersonSchema),
  pinned_messages: z.array(PublicMessageSchema),
  files: z.array(PublicFileSchema),
  messages: z.array(PublicMessageSchema).optional(),
  counts: z.object({ messages: z.number().int(), files: z.number().int() }),
});
export type PublicTicketDetail = z.infer<typeof PublicTicketDetailSchema>;

/**
 * Event types an inbox feed carries: the agent inbox's (agentInbox) and, for a
 * PERSON's token, their own in-app inbox's (users/{uid}/inbox).
 */
export const PUBLIC_EVENT_TYPES = [
  'assigned',
  'unassigned',
  'mentioned',
  'comment',
  'stage',
  'updated',
  'created',
  // phase 3 (§L1): to the agent that asked
  'question_answered',
  'question_cancelled',
  // person tokens only (their in-app inbox)
  'state',
  'dueSoon',
  'overdue',
  'invited',
  /** Phase 3: a person was asked a question. */
  'question',
  /** Phase 3: an agent this person owns went quiet (§L3). */
  'agentSilence',
] as const satisfies readonly (AgentEventType | NotifyEvent)[];
export const PublicEventTypeSchema = z.enum(PUBLIC_EVENT_TYPES);

/** GET /v1/events, /v1/events/stream, MCP get_events — one inbox event. */
export const PublicEventSchema = z.object({
  /** Also a cursor: ids sort by time (agentEventId). */
  id: z.string(),
  type: PublicEventTypeSchema,
  board: PublicBoardRefSchema,
  ticket_id: z.string().nullable(),
  ticket_key: z.string().nullable(),
  message_id: z.string().nullable(),
  actor: PublicActorSchema.nullable(),
  summary: z.string(),
  created_at: Iso,
  acked_at: Iso.nullable(),
  /**
   * Phase 3 (§L1): question_answered / question_cancelled carry the question,
   * and an answer's values keyed by field id, so acting on it needs no second
   * call. Absent on every other event type.
   */
  question: z
    .object({
      id: z.string(),
      title: z.string(),
      status: QuestionStatusSchema,
      values: z.record(z.string(), QuestionValueSchema).optional(),
      comment: z.string().nullable().optional(),
      answered_by: PublicActorSchema.optional(),
    })
    .nullable()
    .optional(),
});
export type PublicEvent = z.infer<typeof PublicEventSchema>;

// ───────────────────────── phase 3: task lists and heartbeat (§L2, §L3) ─────────────────────────

export const PublicTaskItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: TaskItemStatusSchema,
  note: z.string().nullable(),
  updated_at: Iso,
});

/** PUT / PATCH /v1/tickets/{KEY}/tasklists…, MCP set_tasklist / update_task_item. */
export const PublicTasklistSchema = z.object({
  id: z.string(),
  ticket_key: z.string(),
  title: z.string(),
  owner: PublicActorSchema,
  items: z.array(PublicTaskItemSchema),
  position: z.number(),
  /** done + skipped out of the total — the '4 / 7' the UI shows. */
  progress: z.object({ done: z.number().int(), total: z.number().int() }),
  created_at: Iso,
  updated_at: Iso,
  closed_at: Iso.nullable(),
});
export type PublicTasklist = z.infer<typeof PublicTasklistSchema>;

/** POST /v1/heartbeat, MCP heartbeat — the status document that was written. */
export const PublicAgentStatusSchema = z.object({
  agent: PublicActorSchema,
  /** null for an agent-level beat. */
  ticket_key: z.string().nullable(),
  state: AgentStateSchema,
  /** deriveAgentHealth at the time of the answer — 'working' | 'stale' | … */
  health: AgentHealthSchema,
  message: z.string().nullable(),
  progress: z.number().nullable(),
  last_beat_at: Iso,
  started_at: Iso,
  ended_at: Iso.nullable(),
});
export type PublicAgentStatus = z.infer<typeof PublicAgentStatusSchema>;

// ───────────────────────── artifacts (docs/plan/artifacts.html §C1) ─────────────────────────

/** One build of an artifact: a version. The newest ten are kept; any of them can be made current. */
export const PublicArtifactBuildSchema = z.object({
  id: z.string(),
  files: z.number().int(),
  /** Unpacked bytes. */
  bytes: z.number().int(),
  message: z.string().nullable(),
  /** Who published it — a person or an agent. */
  by: PublicActorSchema,
  created_at: Iso,
  /** e.g. the absolute-asset-path warning: the publish succeeded, the page may be blank. */
  warnings: z.array(z.string()),
  /** A source zip came with it (GET /v1/artifacts/{id}/source?build=…). */
  has_source: z.boolean(),
  /** This is the build people see. */
  current: z.boolean(),
});
export type PublicArtifactBuild = z.infer<typeof PublicArtifactBuildSchema>;

/** A person or agent the artifact is shared with. */
export const PublicArtifactMemberSchema = z.object({
  id: z.string(),
  kind: PrincipalKindSchema,
  name: z.string(),
  /** '' for agents. */
  email: z.string(),
  /** A person's role. For an agent this is always 'editor' (kept for older clients) — read `agent_access`. */
  role: ArtifactRoleSchema,
  /** Agents only (§AA3): what this agent may do here — { build, data: 'none' | 'read' | 'write' }. */
  agent_access: ArtifactAgentAccessSchema.optional(),
});
export type PublicArtifactMember = z.infer<typeof PublicArtifactMemberSchema>;

export const PublicArtifactSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** LEGACY: the typed emoji, if any. Read `indicator`. */
  icon: z.string().nullable(),
  /** indicators.html: the artifact's mark. */
  indicator: IndicatorSchema,
  /** Where a person opens it: {app}/x/{id}. An artifact never runs outside that page. */
  url: z.string(),
  /**
   * The role of the principal this credential acts as. An AGENT caller always
   * reads 'editor' here (kept for older clients); what it may actually do is
   * `agent_access`.
   */
  role: ArtifactRoleSchema,
  /**
   * §AA3 — present only when the caller is an AGENT: its own { build, data }
   * on this artifact. build: publish, roll back, source. data: the data API.
   */
  agent_access: ArtifactAgentAccessSchema.optional(),
  /** Viewers may read its data but not write it. */
  read_only: z.boolean(),
  archived: z.boolean(),
  /** The build people see; null until the first publish. */
  current_build: z.string().nullable(),
  owner_id: z.string(),
  created_at: Iso,
  updated_at: Iso,
});
export type PublicArtifact = z.infer<typeof PublicArtifactSchema>;

/** GET /v1/artifacts/{id}: the artifact, its kept builds (newest first) and who it is shared with. */
export const PublicArtifactDetailSchema = PublicArtifactSchema.extend({
  builds: z.array(PublicArtifactBuildSchema),
  members: z.array(PublicArtifactMemberSchema),
});
export type PublicArtifactDetail = z.infer<typeof PublicArtifactDetailSchema>;

/** memory.html §E — one memory file to attach to a message: its memory, and its node id or path. */
export const PublicMemoryFileRefSchema = z
  .object({
    memory_id: z.string().min(1).max(64),
    node_id: z.string().min(1).max(64).optional(),
    path: z.string().min(1).max(1024).optional(),
  })
  .strict()
  .refine((r) => (r.node_id === undefined) !== (r.path === undefined), {
    message: 'Give node_id or path',
  });
export type PublicMemoryFileRef = z.infer<typeof PublicMemoryFileRefSchema>;

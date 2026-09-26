/**
 * REST /v1 request and response schemas — phase 2 (docs/plan/agents.html §F),
 * built for orchestrators holding a BOARD-SCOPED token (API key v2).
 *
 * Resource-shaped JSON + Markdown; the door maps them onto the same commands
 * the app calls. Errors are problem+json (errors.ts); lists use an opaque
 * cursor. Every POST honours an Idempotency-Key header.
 *
 * Board resolution: a BOARD token (API key v2) names exactly one board, so
 * /v1/board and /v1/tickets need no board parameter. Credentials that span
 * several boards — OAuth grants, and PHASE 10's ACCOUNT TOKENS (§R2) — name
 * the board one of three ways, all equivalent:
 *   - in the path:  GET /v1/boards/ENG/tickets
 *   - as a parameter: GET /v1/tickets?board=ENG, or body.board on a POST
 *   - implicitly, by ticket key: /v1/tickets/ENG-42 already names its board.
 * Board tokens keep today's behaviour exactly: the parameter, when given, may
 * only name their own board.
 */
import { z } from 'zod';
import {
  AgentIconIdSchema,
  AgentIdSchema,
  BoardKeySchema,
  ColorSchema,
  PrincipalKindSchema,
  StoragePathSchema,
  TicketStateSchema,
  WebhookEventSchema,
  type Scope,
  ScopeSchema,
} from '../types/index.js';
import { ApiKeyKindSchema } from '../schema/user.js';
import { AgentBoardRoleSchema } from '../schema/board.js';
import { AGENT_DESCRIPTION_MAX, AGENT_NAME_MAX, AGENT_SYSTEM_PROMPT_MAX } from '../schema/agent.js';
import { MAX_API_UPLOAD_BYTES } from '../logic/files.js';
import { MAX_ACK_IDS } from '../commands/agents.js';
import { BOARD_TEMPLATES } from '../commands/boards.js';
import {
  MAX_QUESTION_FIELDS,
  QUESTION_COMMENT_MAX,
  QUESTION_TITLE_MAX,
  QuestionValueSchema,
} from '../schema/question.js';
import {
  MAX_TASKLIST_ITEMS,
  TASK_ITEM_NOTE_MAX,
  TASK_ITEM_TITLE_MAX,
  TASKLIST_TITLE_MAX,
  TaskItemStatusSchema,
} from '../schema/tasklist.js';
import { AGENT_STATUS_MESSAGE_MAX, AgentStateSchema } from '../schema/agentStatus.js';
import {
  PublicAgentSchema,
  PublicAgentStatusSchema,
  PublicRunReceiptSchema,
  PublicQuestionSchema,
  PublicQuestionFieldSchema,
  PublicTasklistSchema,
  PublicBoardRefSchema,
  PublicBoardSchema,
  PublicEventSchema,
  PublicFileSchema,
  PublicMessageSchema,
  PublicTicketDetailSchema,
  PublicTicketSchema,
} from './public.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const REST_DEFAULT_LIMIT = 50;
export const REST_MAX_LIMIT = 200;

const Iso = z.string().datetime({ offset: true });
const Limit = z.coerce.number().int().min(1).max(REST_MAX_LIMIT).default(REST_DEFAULT_LIMIT);
/**
 * A board key, for credentials that span several boards (OAuth grants and
 * §R2 account tokens). A board token may pass its own board's key, and
 * nothing else.
 */
const BoardParam = z.string().min(1).max(8).optional();

/** `{ data, next_cursor }` */
export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ data: z.array(item), next_cursor: z.string().nullable() });
}
export interface Paginated<T> {
  data: T[];
  next_cursor: string | null;
}

// ───────────────────────── identity ─────────────────────────

/**
 * GET /v1/me, MCP whoami — who this token is. For an agent token, everything
 * an orchestrator needs to start the agent: its name, description, avatar and
 * SYSTEM PROMPT, so the prompt can be loaded from the token alone.
 */
export const RestMeResSchema = z.object({
  principal: z.object({
    kind: PrincipalKindSchema,
    id: z.string(),
    name: z.string(),
    /** null for agents. */
    email: z.string().nullable(),
    avatar_url: z.string().nullable(),
    /** Agents: the prebuilt icon id (AGENT_ICON_IDS) shown when there is no picture; null for people. */
    icon: z.string().nullable(),
    /** Agents only. */
    description: z.string().nullable().optional(),
    /** Agents only: Markdown. */
    system_prompt: z.string().optional(),
  }),
  /** Agent tokens: the person who owns the agent (and the token). */
  owner: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
  /** The token's board; null for credentials spanning several boards (see `boards`). */
  board: PublicBoardRefSchema.nullable(),
  /** Multi-board credentials (OAuth): the boards it may act on. */
  boards: z.array(PublicBoardRefSchema).optional(),
  /** The principal's role on `board`. */
  role: z.enum(['admin', 'editor', 'commenter', 'viewer']).nullable(),
  scopes: z.array(ScopeSchema),
  via: z.enum(['api', 'mcp', 'integration']),
  /**
   * §R2 — WHICH KIND OF CREDENTIAL THIS IS, so a client knows without
   * guessing whether it must name a board:
   *   'board'   a board token: `board` is set, `boards` holds just it
   *   'account' an account token: `board` is null and `boards` lists every
   *             board reachable RIGHT NOW (resolved at this call, not cached)
   *   'oauth'   an OAuth access token, narrowed to `boards` by its grant
   */
  kind: z.enum(['board', 'account', 'oauth']),
  /** The API key, when one authenticated the request. */
  token: z
    .object({
      id: z.string(),
      name: z.string(),
      prefix: z.string(),
      expires_at: Iso.nullable(),
      /** §R1: 'board' or 'account' — the same value as the top-level `kind`. */
      kind: ApiKeyKindSchema,
    })
    .nullable(),
});
export type RestMeRes = z.infer<typeof RestMeResSchema>;

// ───────────────────────── board ─────────────────────────

/** GET /v1/board — stages (with categories), priorities, tags, fields, members (people + agents; needs members:read). */
export const RestBoardQuerySchema = z.object({ board: BoardParam });
export const RestBoardResSchema = PublicBoardSchema;
/** GET /v1/boards — multi-board credentials. */
export const RestBoardListResSchema = paginatedSchema(PublicBoardSchema);

// ───────────────────────── tickets ─────────────────────────

/** GET /v1/tickets?assignee=me&stage=&state=&q=&updated_since=&cursor= */
export const RestListTicketsQuerySchema = z.object({
  board: BoardParam,
  /** Stage id or name. */
  stage: z.string().optional(),
  /** 'me', a principal id, an email, or an agent's name. */
  assignee: z.string().optional(),
  q: z.string().optional(),
  updated_since: Iso.optional(),
  /** Default 'active'. */
  state: TicketStateSchema.optional(),
  cursor: z.string().optional(),
  limit: Limit,
});
export const RestTicketListResSchema = paginatedSchema(PublicTicketSchema);

/**
 * Principals may be named by id, email or (agents) name; stage / priority /
 * tags by name or id; fields by NAME (or id).
 */
const TicketWriteShape = {
  title: z.string().trim().min(1).max(500),
  description_md: z.string().max(100_000).nullable(),
  stage: z.string(),
  priority: z.string().nullable(),
  tags: z.array(z.string()),
  /** id | email | agent name. */
  assignees: z.array(z.string()),
  start_at: Iso.nullable(),
  due_at: Iso.nullable(),
  due_all_day: z.boolean(),
  estimate: z.number().nonnegative().nullable(),
  fields: z.record(z.string(), z.unknown()),
};

/** POST /v1/tickets */
export const RestCreateTicketBodySchema = z
  .object(TicketWriteShape)
  .partial()
  .required({ title: true })
  .extend({ board: BoardParam })
  .strict();
export type RestCreateTicketBody = z.infer<typeof RestCreateTicketBodySchema>;
export const RestCreateTicketResSchema = PublicTicketSchema;

/** GET /v1/tickets/{KEY}?messages=N — the last N messages too (0–100, default 0). */
export const RestGetTicketQuerySchema = z.object({
  messages: z.coerce.number().int().min(0).max(100).default(0),
});
export const RestTicketDetailResSchema = PublicTicketDetailSchema;

export const RestLinkSchema = z.object({
  type: z.enum(['blocks', 'blockedBy', 'relates', 'duplicates']),
  key: z.string(),
});

/**
 * PATCH /v1/tickets/{KEY}. Scopes: stage → tickets:move, assignees →
 * tickets:assign, everything else → tickets:update (all that apply).
 */
export const RestPatchTicketBodySchema = z
  .object({ ...TicketWriteShape, links: z.array(RestLinkSchema) })
  .partial()
  .strict();
export type RestPatchTicketBody = z.infer<typeof RestPatchTicketBodySchema>;

/** The scopes a REST / MCP ticket patch needs (every one of them). */
export function restPatchScopes(body: Record<string, unknown>): Scope[] {
  const out = new Set<Scope>();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || k === 'key' || k === 'board') continue;
    out.add(
      k === 'stage' ? 'tickets:move' : k === 'assignees' ? 'tickets:assign' : 'tickets:update',
    );
  }
  return [...out];
}

/** POST /v1/tickets/{KEY}/move */
export const RestMoveBodySchema = z.object({ stage: z.string().min(1) }).strict();
/** POST /v1/tickets/{KEY}/state — restoring to 'active' needs an admin person. */
export const RestStateBodySchema = z.object({ state: TicketStateSchema }).strict();
/** POST /v1/tickets/{KEY}/assignees — add / remove without replacing the list. */
export const RestAssigneesBodySchema = z
  .object({
    add: z.array(z.string()).max(50).optional(),
    remove: z.array(z.string()).max(50).optional(),
  })
  .strict()
  .refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, {
    message: 'Nothing to add or remove',
  });
/** Move / state / assignees answer with the updated ticket. */
export const RestTicketResSchema = PublicTicketSchema;

// ───────────────────────── messages ─────────────────────────

/** GET /v1/tickets/{KEY}/messages?cursor= — oldest first by default. */
export const RestMessagesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: Limit,
  order: z.enum(['asc', 'desc']).default('asc'),
});
export const RestMessageListResSchema = paginatedSchema(PublicMessageSchema);

/**
 * POST /v1/tickets/{KEY}/messages. Mention people as @email or
 * [@Name](mailto:email), agents as @ag_… or [@Name](agent:ag_…), tickets as #KEY.
 * A message may be files only (empty body_markdown, attachments present).
 */
export const RestPostMessageBodySchema = z
  .object({
    body_markdown: z.string().max(100_000).default(''),
    /** File ids already on this ticket (POST …/files). */
    attachments: z.array(z.string().min(1)).max(20).optional(),
    reply_to: z.string().min(1).optional(),
    /**
     * Phase 17 (§Y1): the TURN RECEIPT. Post it once per run of the agent,
     * with the body saying the same in words ('Turn 3 · review · $1.24 · 12
     * min'). It is added to the ticket's, the board's and the day's cost.
     */
    run: PublicRunReceiptSchema.nullable().optional(),
  })
  .strict()
  .refine((b) => b.body_markdown.trim().length > 0 || (b.attachments?.length ?? 0) > 0, {
    message: 'A message needs body_markdown or attachments',
  });
export type RestPostMessageBody = z.infer<typeof RestPostMessageBodySchema>;
export const RestPostMessageResSchema = PublicMessageSchema;

// ───────────────────────── files ─────────────────────────

/** Multipart upload: the file part's field name (an optional `name` field overrides its filename). */
export const REST_UPLOAD_FIELD = 'file';

/**
 * POST /v1/tickets/{KEY}/files as JSON: `text` (makes .md / .html documents
 * trivial) or `content_base64`, exactly one. ≤ MAX_API_UPLOAD_BYTES decoded.
 * mime defaults from the name (mimeForName).
 */
export const RestUploadJsonBodySchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    mime: z.string().min(1).max(255).optional(),
    text: z.string().optional(),
    content_base64: z.string().optional(),
  })
  .strict()
  .refine((b) => (b.text === undefined) !== (b.content_base64 === undefined), {
    message: 'Exactly one of text or content_base64',
  })
  .refine(
    (b) =>
      (b.text ?? '').length <= MAX_API_UPLOAD_BYTES &&
      (b.content_base64 ?? '').length <= Math.ceil((MAX_API_UPLOAD_BYTES * 4) / 3) + 4,
    {
      message: `At most ${MAX_API_UPLOAD_BYTES / 1024 / 1024} MB`,
    },
  );
export type RestUploadJsonBody = z.infer<typeof RestUploadJsonBodySchema>;
/** → { file_id, url, …PublicFile }. Pass file_id in a message's `attachments`. */
export const RestUploadResSchema = PublicFileSchema.extend({ file_id: z.string() });

/** GET /v1/tickets/{KEY}/files */
export const RestFileListResSchema = z.object({ data: z.array(PublicFileSchema) });

/** GET /v1/files/{fileId}?content=1 — content only for textual kinds (else 422 names the kind). */
export const RestGetFileQuerySchema = z.object({
  content: z
    .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false'), z.boolean()])
    .transform((v) => v === true || v === '1' || v === 'true')
    .optional(),
});
export const RestFileResSchema = PublicFileSchema.extend({
  /** With ?content=1: the text (UTF-8). */
  content: z.string().optional(),
  /** Content longer than MAX_INLINE_TEXT_BYTES is cut; the url has it all. */
  content_truncated: z.boolean().optional(),
});
export type RestFileRes = z.infer<typeof RestFileResSchema>;

// ───────────────────────── events ─────────────────────────

/**
 * GET /v1/events?cursor=&limit= — the token's inbox, oldest first: events
 * with id > cursor. An agent token reads agentInbox/{agentId}; a person's
 * token reads their own in-app inbox (on its board). next_cursor = the last
 * id returned (or the given cursor when nothing is new): poll with it.
 */
export const RestEventsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: Limit,
  /** Skip events already acked (default false: the cursor alone decides). */
  unacked: z
    .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false'), z.boolean()])
    .transform((v) => v === true || v === '1' || v === 'true')
    .optional(),
});
export const RestEventListResSchema = z.object({
  data: z.array(PublicEventSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

/**
 * GET /v1/events/stream?cursor= — Server-Sent Events of the same items:
 *   event: event   id: <event id>   data: <PublicEvent JSON>
 *   event: ping    (keep-alive, every SSE_PING_MS)
 * Reconnect with Last-Event-ID (or ?cursor=) to resume.
 */
export const SSE_EVENT = 'event';
export const SSE_PING = 'ping';
export const SSE_PING_MS = 25_000;

/** POST /v1/events/ack — { ids } or { upTo: cursor }. */
export const RestAckBodySchema = z.union([
  z.object({ ids: z.array(z.string().min(1)).min(1).max(MAX_ACK_IDS) }).strict(),
  z.object({ upTo: z.string().min(1) }).strict(),
]);
export const RestAckResSchema = z.object({ acked: z.number().int().nonnegative() });

// ───────────────────────── phase 3: questions (§L1, §L4) ─────────────────────────

/**
 * POST /v1/tickets/{KEY}/questions (MCP ask_question) — ask a question that
 * appears in the thread as a form card. Fields are 1–10; single / multi carry
 * their options. `to` names who should answer ('me', an id, an email or an
 * agent's name); absent / null = anyone on the board who may comment.
 */
export const RestAskQuestionBodySchema = z
  .object({
    title: z.string().trim().min(1).max(QUESTION_TITLE_MAX),
    /** Optional context, Markdown. */
    body_markdown: z.string().max(100_000).nullable().optional(),
    fields: z.array(PublicQuestionFieldSchema).min(1).max(MAX_QUESTION_FIELDS),
    allow_comment: z.boolean().optional(),
    to: z.array(z.string()).max(50).nullable().optional(),
    /** Default true: the ticket shows 'Waiting for your answer'. */
    blocking: z.boolean().optional(),
    expires_at: Iso.nullable().optional(),
  })
  .strict();
export type RestAskQuestionBody = z.infer<typeof RestAskQuestionBodySchema>;

/** POST …/questions, GET /v1/questions/{id}, POST /v1/questions/{id}/cancel. */
export const RestQuestionResSchema = PublicQuestionSchema;

/**
 * Answering is a PERSON's act, done in the app — there is no /v1 route for it
 * (a token that could answer its own question would defeat the point). The
 * shape is here because MCP's get_question and the webhook payload echo it.
 */
export const RestQuestionAnswerSchema = z
  .object({
    values: z.record(z.string(), QuestionValueSchema),
    comment: z.string().max(QUESTION_COMMENT_MAX).optional(),
  })
  .strict();

// ───────────────────────── phase 3: task lists (§L2, §L4) ─────────────────────────

export const RestTaskItemBodySchema = z
  .object({
    /** Keep an id to keep the item's identity across a replace. */
    id: z.string().min(1).max(64).optional(),
    title: z.string().trim().min(1).max(TASK_ITEM_TITLE_MAX),
    status: TaskItemStatusSchema.optional(),
    note: z.string().max(TASK_ITEM_NOTE_MAX).optional(),
  })
  .strict();

/** PUT /v1/tickets/{KEY}/tasklists/{listId} — create or replace the whole list. */
export const RestSetTasklistBodySchema = z
  .object({
    title: z.string().trim().min(1).max(TASKLIST_TITLE_MAX),
    items: z.array(RestTaskItemBodySchema).max(MAX_TASKLIST_ITEMS),
    position: z.number().optional(),
    /** true adds the 'finished' system line to the thread. */
    closed: z.boolean().optional(),
  })
  .strict();
export type RestSetTasklistBody = z.infer<typeof RestSetTasklistBodySchema>;

/** PATCH /v1/tickets/{KEY}/tasklists/{listId}/items/{itemId} — one item. */
export const RestUpdateTaskItemBodySchema = z
  .object({
    status: TaskItemStatusSchema.optional(),
    note: z.string().max(TASK_ITEM_NOTE_MAX).nullable().optional(),
  })
  .strict()
  .refine((b) => b.status !== undefined || b.note !== undefined, { message: 'Nothing to update' });

export const RestTasklistResSchema = PublicTasklistSchema;
/** GET /v1/tickets/{KEY}/tasklists. */
export const RestTasklistListResSchema = z.object({ data: z.array(PublicTasklistSchema) });
/** DELETE /v1/tickets/{KEY}/tasklists/{listId}. */
export const RestDeletedResSchema = z.object({ deleted: z.literal(true) });

// ───────────────────────── phase 3: heartbeat (§L3, §L4) ─────────────────────────

/**
 * POST /v1/heartbeat (MCP heartbeat) — every minute while the agent works, and
 * once when the work ends. `ticket` is a ticket KEY; omit it for an
 * agent-level beat. Beats never touch the ticket document (§L3).
 */
export const RestHeartbeatBodySchema = z
  .object({
    ticket: z.string().min(1).optional(),
    state: AgentStateSchema,
    message: z.string().max(AGENT_STATUS_MESSAGE_MAX).nullable().optional(),
    progress: z.number().min(0).max(1).nullable().optional(),
    /** Multi-board credentials only; a board-scoped key implies its board. */
    board: BoardParam,
  })
  .strict();
export type RestHeartbeatBody = z.infer<typeof RestHeartbeatBodySchema>;
export const RestHeartbeatResSchema = PublicAgentStatusSchema;

/** GET /v1/agents/status?ticket= — what every agent on the board is doing. */
export const RestAgentStatusListResSchema = z.object({ data: z.array(PublicAgentStatusSchema) });

// ───────────────────────── phase 17 (§Z2): account-token routes ─────────────────────────

/**
 * POST /v1/agents — agentCreate's REST face. ACCOUNT tokens only (agents:write
 * is an account scope): an agent profile is account-level, not board-level.
 * `avatar` is a Storage path already under the owner's agent-avatar prefix,
 * which needs `id` chosen up front (the command's rule); a token cannot
 * upload one, so it is for clients that already did.
 */
export const RestCreateAgentBodySchema = z
  .object({
    /** Optional client-chosen 'ag_' + 16 id (a taken one → 409). */
    id: AgentIdSchema.optional(),
    name: z.string().trim().min(1).max(AGENT_NAME_MAX),
    description: z.string().trim().max(AGENT_DESCRIPTION_MAX).nullable().optional(),
    /** Markdown; handed to the agent's tokens by GET /v1/me. */
    system_prompt: z.string().max(AGENT_SYSTEM_PROMPT_MAX).optional(),
    avatar: StoragePathSchema.nullable().optional(),
    /** A prebuilt icon id (one of AGENT_ICON_IDS, e.g. 'claude', 'bot'); shown when there is no picture. */
    icon: AgentIconIdSchema.nullable().optional(),
  })
  .strict();
export type RestCreateAgentBody = z.infer<typeof RestCreateAgentBodySchema>;
export const RestAgentResSchema = PublicAgentSchema;

/**
 * POST /v1/boards — boardCreate's REST face (boards:create, account tokens
 * only). The caller becomes the board's only admin. `template` is one of the
 * built-in seeds ('kanban' has the To do / In progress / Review / Done stages
 * an orchestrator expects); default 'blank'.
 */
export const RestCreateBoardBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** 2–6 chars, A–Z then A–Z/0–9; 409 when taken. */
    key: BoardKeySchema,
    template: z.enum(BOARD_TEMPLATES).optional(),
    color: ColorSchema.optional(),
    icon: z.string().max(64).optional(),
  })
  .strict();
export type RestCreateBoardBody = z.infer<typeof RestCreateBoardBodySchema>;
/** Answers the board as GET /v1/boards/{KEY} does (members included). */
export const RestCreateBoardResSchema = PublicBoardSchema;

/**
 * POST /v1/boards/{KEY}/agents — boardAgentSet's REST face (account tokens:
 * agents:write or boards:admin, and the person must be a board admin who
 * owns the agent to ADD it). `role: null` removes the agent from the board.
 * `stage_grant` is for commenters only; null clears it, absent keeps it.
 */
export const RestBoardAgentBodySchema = z
  .object({
    /** 'ag_…' from POST /v1/agents. */
    agent: AgentIdSchema,
    role: AgentBoardRoleSchema.nullable(),
    stage_grant: z
      .object({ stages: z.array(z.string().min(1)), assigned_only: z.boolean().optional() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type RestBoardAgentBody = z.infer<typeof RestBoardAgentBodySchema>;
export const RestOkResSchema = z.object({ ok: z.literal(true) });

// ───────────────────────── phase 17 (§W, §Z1): the live credential ─────────────────────────

/**
 * GET /v1/live — a short-lived Realtime Database credential for THIS token,
 * so an orchestrator holds ONE streaming connection (plain SSE, no Firebase
 * SDK) on the nodes the command layer bumps, instead of polling:
 *
 *   rev/{boardId}            'something on this board changed'
 *   agents/{agentId}/wake    'something is in your inbox'   (agent tokens)
 *
 * Stream `{database_url}/{path}.json?auth={auth}` with `Accept:
 * text/event-stream`; re-mint when `expires_in` runs out (the SDK's
 * tm.watch() does all of this). `paths` are exactly the nodes this
 * credential may read: an agent's wake node plus its board's rev; a
 * person's token gets rev/{b} for every board it reaches right now.
 */
export const RestLiveResSchema = z.object({
  /** The RTDB origin, e.g. https://<instance>.<region>.firebasedatabase.app */
  database_url: z.string(),
  /** The `?auth=` value: a Firebase ID token minted for this principal. */
  auth: z.string(),
  /** Seconds until `auth` stops working (advisory: re-mint then). */
  expires_in: z.number().int().positive(),
  paths: z.array(z.string()),
});
export type RestLiveRes = z.infer<typeof RestLiveResSchema>;

// ───────────────────────── search, webhooks ─────────────────────────

/** GET /v1/search?q= */
export const RestSearchQuerySchema = z.object({
  q: z.string().min(1),
  board: z.string().optional(),
  limit: Limit,
});
export const RestSearchResSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      title: z.string(),
      board_key: z.string(),
      state: z.string(),
    }),
  ),
});

/** CRUD /v1/webhooks */
export const RestWebhookSchema = z.object({
  id: z.string(),
  board: z.string(),
  url: z.string(),
  events: z.array(WebhookEventSchema),
  active: z.boolean(),
  failures: z.number(),
  created_at: Iso,
});
export const RestWebhookBodySchema = z
  .object({
    /** Board key. */
    board: z.string(),
    url: z.string().url().startsWith('https://'),
    events: z.array(WebhookEventSchema).min(1),
    active: z.boolean().optional(),
    rotate_secret: z.boolean().optional(),
  })
  .strict();
export const RestWebhookUpsertResSchema = RestWebhookSchema.extend({
  secret: z.string().optional(),
});
export const RestWebhookListResSchema = paginatedSchema(RestWebhookSchema);

// ───────────────────────── phase-1 shapes (deprecated) ─────────────────────────

/** @deprecated phase 1 — use GET /v1/tickets/{KEY}/messages (RestMessagesQuerySchema). */
export const RestCommentsQuerySchema = z.object({ cursor: z.string().optional(), limit: Limit });
/** @deprecated phase 1 — use RestMessageListResSchema. */
export const RestCommentListResSchema = RestMessageListResSchema;
/** @deprecated phase 1 — use RestPostMessageBodySchema. */
export const RestCommentBodySchema = z
  .object({ body_md: z.string().min(1).max(100_000), attachments: z.array(z.string()).optional() })
  .strict();
/** @deprecated phase 1 — use POST /v1/tickets/{KEY}/files (RestUploadJsonBodySchema). */
export const RestAttachmentBodySchema = z
  .object({
    name: z.string().min(1).max(255),
    mime: z.string().min(1),
    size: z.number().int().positive(),
  })
  .strict();
/** @deprecated phase 1. */
export const RestAttachmentResSchema = z.object({
  upload_url: z.string(),
  path: z.string(),
  expires_at: Iso,
});

// ───────────────────────── the route table ─────────────────────────

export interface RestRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** A token needs ANY of these (the handler checks finer ones, e.g. restPatchScopes). [] = any valid credential. */
  scopes: readonly Scope[];
  /** Needs a single board: the token's, or ?board= / body.board for multi-board credentials. */
  board?: boolean;
  summary: string;
}

/** Every /v1 route (openapi.json is generated from this). */
export const REST_ROUTES = [
  {
    method: 'GET',
    path: '/v1/me',
    scopes: [],
    summary: 'Who this token is (agent: name, description, system prompt)',
  },
  {
    method: 'GET',
    path: '/v1/board',
    scopes: ['board:read'],
    board: true,
    summary: 'Stages, priorities, tags, fields, members',
  },
  {
    method: 'GET',
    path: '/v1/boards',
    scopes: ['board:read'],
    summary:
      'Boards this credential may act on (an account token: every board you are on right now)',
  },
  // §R2: the board IN THE PATH, for account tokens and any other credential
  // that spans boards. Exactly the same handlers as the two routes above.
  {
    method: 'GET',
    path: '/v1/boards/{KEY}',
    scopes: ['board:read'],
    summary: 'One board: stages, priorities, tags, fields, members',
  },
  // phase 17 (§Z2): ACCOUNT-TOKEN routes — the REST face of boardCreate,
  // agentCreate and boardAgentSet, which the app door already exposes to a
  // signed-in person. Their scopes are account scopes, so a board token is
  // refused (403) before any handler runs.
  {
    method: 'POST',
    path: '/v1/boards',
    scopes: ['boards:create'],
    summary: 'Create a board (account token); you become its admin',
  },
  {
    method: 'POST',
    path: '/v1/boards/{KEY}/agents',
    scopes: ['agents:write', 'boards:admin'],
    summary: 'Put an agent you own on a board with a role, change it, or remove it (account token)',
  },
  {
    method: 'POST',
    path: '/v1/agents',
    scopes: ['agents:write'],
    summary: 'Create an agent profile (account token)',
  },
  {
    method: 'GET',
    path: '/v1/boards/{KEY}/tickets',
    scopes: ['tickets:read'],
    summary: 'List tickets on a named board',
  },
  {
    method: 'POST',
    path: '/v1/boards/{KEY}/tickets',
    scopes: ['tickets:create'],
    summary: 'Create a ticket on a named board',
  },
  {
    method: 'GET',
    path: '/v1/tickets',
    scopes: ['tickets:read'],
    board: true,
    summary: 'List tickets',
  },
  {
    method: 'POST',
    path: '/v1/tickets',
    scopes: ['tickets:create'],
    board: true,
    summary: 'Create a ticket',
  },
  {
    method: 'GET',
    path: '/v1/tickets/{KEY}',
    scopes: ['tickets:read'],
    summary: 'A ticket with links, pinned messages, files',
  },
  {
    method: 'PATCH',
    path: '/v1/tickets/{KEY}',
    scopes: ['tickets:update', 'tickets:move', 'tickets:assign'],
    summary: 'Update a ticket',
  },
  {
    method: 'POST',
    path: '/v1/tickets/{KEY}/move',
    scopes: ['tickets:move'],
    summary: 'Move to a stage',
  },
  {
    method: 'POST',
    path: '/v1/tickets/{KEY}/state',
    scopes: ['tickets:state'],
    summary: 'Archive or restore',
  },
  {
    method: 'POST',
    path: '/v1/tickets/{KEY}/assignees',
    scopes: ['tickets:assign'],
    summary: 'Add or remove assignees',
  },
  {
    method: 'GET',
    path: '/v1/tickets/{KEY}/messages',
    scopes: ['comments:read'],
    summary: 'The thread, Markdown bodies',
  },
  {
    method: 'POST',
    path: '/v1/tickets/{KEY}/messages',
    scopes: ['comments:write'],
    summary: 'Post a Markdown message with file attachments',
  },
  {
    method: 'GET',
    path: '/v1/tickets/{KEY}/files',
    scopes: ['files:read'],
    summary: 'Every file on the ticket',
  },
  {
    method: 'POST',
    path: '/v1/tickets/{KEY}/files',
    scopes: ['files:write'],
    summary: 'Upload a file (multipart or JSON text / base64)',
  },
  {
    method: 'GET',
    path: '/v1/files/{fileId}',
    scopes: ['files:read'],
    summary: 'File metadata + signed URL; ?content=1 for text',
  },
  {
    method: 'GET',
    path: '/v1/events',
    scopes: ['events:read'],
    summary: 'The inbox feed (cursor)',
  },
  {
    method: 'GET',
    path: '/v1/events/stream',
    scopes: ['events:read'],
    summary: 'The inbox as Server-Sent Events',
  },
  {
    method: 'POST',
    path: '/v1/events/ack',
    scopes: ['events:read'],
    summary: 'Acknowledge events',
  },
  {
    method: 'GET',
    path: '/v1/live',
    scopes: ['events:read'],
    summary:
      'A short-lived Realtime Database credential: wake on rev/{board} and your inbox instead of polling',
  },
  // phase 3 (§L4)
  {
    method: 'POST',
    path: '/v1/tickets/{KEY}/questions',
    scopes: ['questions:write'],
    summary: 'Ask a question as a form card in the thread',
  },
  {
    method: 'GET',
    path: '/v1/questions/{id}',
    scopes: ['comments:read'],
    summary: 'A question: its status and, once given, the answer',
  },
  {
    method: 'POST',
    path: '/v1/questions/{id}/cancel',
    scopes: ['questions:write'],
    summary: 'Cancel a question you asked',
  },
  {
    method: 'GET',
    path: '/v1/tickets/{KEY}/tasklists',
    scopes: ['tickets:read'],
    summary: "The ticket's task lists",
  },
  {
    method: 'PUT',
    path: '/v1/tickets/{KEY}/tasklists/{listId}',
    scopes: ['tasklists:write'],
    summary: 'Create or replace a task list',
  },
  {
    method: 'PATCH',
    path: '/v1/tickets/{KEY}/tasklists/{listId}/items/{itemId}',
    scopes: ['tasklists:write'],
    summary: "Update one item's status or note",
  },
  {
    method: 'DELETE',
    path: '/v1/tickets/{KEY}/tasklists/{listId}',
    scopes: ['tasklists:write'],
    summary: 'Delete a task list',
  },
  {
    method: 'POST',
    path: '/v1/heartbeat',
    scopes: ['status:write'],
    board: true,
    summary: 'Say what you are doing (every minute, and when work ends)',
  },
  {
    method: 'GET',
    path: '/v1/agents/status',
    scopes: ['members:read'],
    board: true,
    summary: 'What every agent on the board is doing',
  },
  { method: 'GET', path: '/v1/search', scopes: ['tickets:read'], summary: 'Search tickets' },
  { method: 'GET', path: '/v1/webhooks', scopes: ['webhooks:manage'], summary: 'List webhooks' },
  {
    method: 'POST',
    path: '/v1/webhooks',
    scopes: ['webhooks:manage'],
    summary: 'Create a webhook',
  },
  {
    method: 'PATCH',
    path: '/v1/webhooks/{id}',
    scopes: ['webhooks:manage'],
    summary: 'Update a webhook',
  },
  {
    method: 'DELETE',
    path: '/v1/webhooks/{id}',
    scopes: ['webhooks:manage'],
    summary: 'Delete a webhook',
  },
] as const satisfies readonly RestRoute[];

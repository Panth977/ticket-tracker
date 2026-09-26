/**
 * Every shape the /v1 API exchanges, written in plain TypeScript.
 *
 * WHY NOT `z.infer` FROM @tm/shared DIRECTLY: the shipped artefacts must be a
 * single flat `sdk.d.ts` (and a single `sdk.ts`) with no imports left — an
 * orchestrator on Deno gets its types from a URL, and a `.d.ts` that still
 * said `z.infer<typeof PublicTicketSchema>` would need zod and @tm/shared on
 * the other side. So the shapes are spelled out here…
 *
 * …and `test/contract.ts` asserts, IN BOTH DIRECTIONS, that each one is
 * structurally identical to the @tm/shared schema the server validates with.
 * Two-way assignability is type identity, so a field that drifts on the server
 * is a compile error in `pnpm --filter @tm/sdk typecheck`, never a surprise
 * 400 at runtime. That check is the link the spec asks for ("its types come
 * from the same @tm/shared schemas the server validates with").
 *
 * Naming: @tm/shared calls these `PublicTicket`, `PublicMessage` … — the
 * "public" prefix answers "public as opposed to the stored document", which
 * is a distinction that does not exist out here. The SDK drops it.
 */

/** An ISO 8601 timestamp with an offset, e.g. `2026-09-23T10:42:00.000Z`. */
export type Iso = string;

/** What a token may do. Narrows the acting principal's board role; never widens it. */
export type Scope =
  | 'board:read'
  | 'members:read'
  | 'tickets:read'
  | 'tickets:create'
  | 'tickets:update'
  | 'tickets:move'
  | 'tickets:assign'
  | 'tickets:state'
  | 'comments:read'
  | 'comments:write'
  | 'files:read'
  | 'files:write'
  | 'questions:write'
  | 'tasklists:write'
  | 'status:write'
  | 'events:read'
  | 'board:admin'
  | 'webhooks:manage'
  // §R1 — ACCOUNT-LEVEL scopes, only ever carried by an account token. They
  // still only narrow: 'boards:admin' reaches board settings on the boards
  // where you are an admin today, and nowhere else.
  | 'boards:create'
  | 'boards:admin'
  | 'agents:write'
  | 'invites:write';

/** A person (a Firebase uid) or an agent (`ag_` + 16 chars). */
export type PrincipalKind = 'user' | 'agent';
export type BoardRole = 'admin' | 'editor' | 'commenter' | 'viewer';
/** Phase 6: 'cancelled' is gone — a ticket is active or archived, and what
 *  used to be Cancel is now a permanent delete. StageCategory keeps its own
 *  'cancelled' below: that is a COLUMN ("Won't do"), not the ticket's state. */
export type TicketState = 'active' | 'archived';
export type StageCategory = 'backlog' | 'todo' | 'active' | 'done' | 'cancelled';
/** How a change reached the system. */
export type Via =
  'app' | 'api' | 'mcp' | 'email' | 'whatsapp' | 'intake' | 'integration' | 'system';
export type LinkType = 'blocks' | 'blockedBy' | 'relates' | 'duplicates';

/** What kind of thing a file is — decides whether `read()` returns text. */
export type FileKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'markdown'
  | 'html'
  | 'pdf'
  | 'text'
  | 'csv'
  | 'json'
  | 'code'
  | 'other';

// ───────────────────────── principals ─────────────────────────

/** A person or an agent, as the API states them. Agents have `email: ''`. */
export interface Principal {
  id: string;
  kind: PrincipalKind;
  name: string;
  /** `''` for agents. */
  email: string;
  avatar_url: string | null;
  /** Agents: a prebuilt icon id (e.g. 'claude', 'bot') shown when there is no picture; null for people. */
  icon: string | null;
}

/** Who did something, compactly (messages, events, activity). */
export interface Actor {
  id: string | null;
  kind: PrincipalKind | null;
  name: string;
}

export interface Member extends Principal {
  role: BoardRole;
  /** Agents: their one-line description. */
  description?: string | null | undefined;
  /** Commenters: the stages they may move tickets between. */
  stage_grant?: { stages: string[]; assigned_only: boolean } | null | undefined;
}

// ───────────────────────── board ─────────────────────────

export interface Stage {
  id: string;
  name: string;
  category: StageCategory;
}
export interface Option {
  id: string;
  name: string;
}
export interface FieldDef {
  id: string;
  name: string;
  type: string;
  required: boolean;
  /** select / multiSelect choices, by name. */
  options?: string[] | undefined;
}

export interface BoardRef {
  id: string;
  key: string;
  name: string;
}

/**
 * What the agents' turns have cost (§Y2): on a ticket, every receipt ever
 * posted on it; on a board, its lifetime. null until the first receipt.
 */
export interface Cost {
  usd: number;
  /** How many turn receipts were posted. */
  runs: number;
}

export interface Board extends BoardRef {
  url: string;
  description_md: string | null;
  stages: Stage[];
  priorities: Option[];
  tags: Option[];
  fields: FieldDef[];
  /** Needs `members:read`; omitted from list responses. */
  members?: Member[] | undefined;
  archived: boolean;
  cost: Cost | null;
}

/** `POST /v1/agents` (account tokens): an agent profile you own. */
export interface Agent {
  /** `ag_…` — pass it to `boards.setAgent()`. */
  id: string;
  kind: 'agent';
  name: string;
  description: string | null;
  /** Markdown; `GET /v1/me` hands it to the agent's tokens. */
  system_prompt: string;
  avatar_url: string | null;
  /** A prebuilt icon id (e.g. 'claude', 'bot'), or null. */
  icon: string | null;
  archived: boolean;
  created_at: Iso;
}

// ───────────────────────── tickets ─────────────────────────

export interface TicketLink {
  type: string;
  key: string;
}

export interface Ticket {
  id: string;
  key: string;
  url: string;
  title: string;
  description_md: string | null;
  board: BoardRef;
  stage: Stage;
  priority: Option | null;
  /** Tag names. */
  tags: string[];
  assignees: Principal[];
  start_at: Iso | null;
  due_at: Iso | null;
  due_all_day: boolean;
  estimate: number | null;
  /** Keyed by field NAME. */
  fields: Record<string, unknown>;
  links: TicketLink[];
  /** Keys of tickets whose text #mentions this one. */
  referenced_by: string[];
  state: TicketState;
  /** What the agents' turns on this ticket have cost; null until the first receipt. */
  cost: Cost | null;
  created_at: Iso;
  updated_at: Iso;
}

/** `GET /v1/tickets/{KEY}`: the ticket plus what an agent needs to start work. */
export interface TicketDetail extends Ticket {
  watchers: Principal[];
  pinned_messages: Message[];
  files: TmFile[];
  /** Present when `messages: N` was asked for; oldest first. */
  messages?: Message[] | undefined;
  counts: { messages: number; files: number };
}

// ───────────────────────── files ─────────────────────────

/** A file as a message lists it. */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: FileKind;
  /** Short-lived signed URL; absent when it was not resolved. */
  url?: string | undefined;
}

/**
 * A file on a ticket. Named `TmFile` because `File` is a global everywhere
 * this runs; `tm.files.get()` returns it.
 */
export interface TmFile extends Attachment {
  ticket_key: string;
  /** Syntax-highlighting guess for text-ish kinds. */
  language: string | null;
  /** true when `read()` / `?content=1` can return the text. */
  textual: boolean;
  width?: number | null | undefined;
  height?: number | null | undefined;
  url_expires_at?: Iso | undefined;
  /** The message it hangs off; null when only uploaded, or on the description. */
  message_id: string | null;
  source: 'description' | 'message' | 'upload';
  uploaded_by: Actor;
  created_at: Iso;
}

/** What `tm.files.upload()` answers with: the file, plus `file_id`. */
export interface UploadedFile extends TmFile {
  file_id: string;
}

/** `GET /v1/files/{id}?content=1`. */
export interface FileWithContent extends TmFile {
  content?: string | undefined;
  /** Content over the inline limit is cut; the signed `url` has all of it. */
  content_truncated?: boolean | undefined;
}

// ───────────────────────── messages and questions ─────────────────────────

export type MessageKind = 'comment' | 'system' | 'question';

export type QuestionFieldType =
  'single' | 'multi' | 'text' | 'longText' | 'number' | 'boolean' | 'date';
export type QuestionStatus = 'open' | 'answered' | 'cancelled' | 'expired';
/** What an answer may hold for one field. */
export type QuestionValue = string | number | boolean | string[];

export interface QuestionFieldOption {
  id: string;
  label: string;
  description?: string | undefined;
}

export interface QuestionField {
  id: string;
  label: string;
  type: QuestionFieldType;
  /** single / multi only. */
  options?: QuestionFieldOption[] | undefined;
  required?: boolean | undefined;
  default?: QuestionValue | undefined;
  placeholder?: string | undefined;
}

export interface QuestionAnswer {
  /** Keyed by FIELD ID. */
  values: Record<string, QuestionValue>;
  comment: string | null;
  by: Actor;
  at: Iso;
}

export interface Question {
  id: string;
  ticket_key: string;
  /** The form card's place in the thread. */
  message_id: string;
  title: string;
  body_md: string | null;
  fields: QuestionField[];
  allow_comment: boolean;
  /** Who should answer; null = anyone on the board who may comment. */
  to: Principal[] | null;
  blocking: boolean;
  status: QuestionStatus;
  expires_at: Iso | null;
  asked_by: Actor;
  created_at: Iso;
  /** null until somebody submits. */
  answer: QuestionAnswer | null;
}

/** How one run of an agent ended (§Y1). */
export type RunOutcome = 'review' | 'waiting' | 'blocked' | 'failed' | 'stopped' | 'timeout';

export interface RunUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/**
 * THE TURN RECEIPT (§Y1): what one finished run of an agent cost, as the API
 * states it — on `Message.run`, and what `messages.post({ run })` sends.
 * `cost_usd` is THIS turn; `session_usd` the running total of the resumed
 * session as Claude reports it.
 */
export interface RunReceipt {
  /** The orchestrator's run counter on this ticket, 1-based. */
  n: number;
  outcome: RunOutcome;
  cost_usd: number;
  session_usd: number | null;
  duration_ms: number;
  api_turns: number | null;
  model: string | null;
  usage: RunUsage | null;
}

export interface Message {
  id: string;
  ticket_key: string;
  kind: MessageKind;
  body_md: string;
  /** Set on `kind: 'question'`: the form card, its status and the answer. */
  question?: Question | null | undefined;
  author: Actor;
  via: Via;
  /** The token's name when one posted this ("… via token orch-eng-builder"). */
  via_token: string | null;
  reply_to: string | null;
  attachments: Attachment[];
  reactions: Record<string, number>;
  pinned: boolean;
  /** The turn receipt, when this message is one (§Y1); null otherwise. */
  run: RunReceipt | null;
  created_at: Iso;
  edited_at: Iso | null;
  deleted: boolean;
}

// ───────────────────────── task lists, heartbeat ─────────────────────────

export type TaskItemStatus = 'todo' | 'doing' | 'done' | 'skipped' | 'failed';

export interface TaskItem {
  id: string;
  title: string;
  status: TaskItemStatus;
  note: string | null;
  updated_at: Iso;
}

export interface Tasklist {
  id: string;
  ticket_key: string;
  title: string;
  owner: Actor;
  items: TaskItem[];
  position: number;
  /** done + skipped out of the total — the "4 / 7" the UI shows. */
  progress: { done: number; total: number };
  created_at: Iso;
  updated_at: Iso;
  closed_at: Iso | null;
}

export type AgentState = 'working' | 'idle' | 'done' | 'error';
/** What the UI draws, derived from the state and the age of the last beat. */
export type AgentHealth = 'working' | 'stale' | 'idle' | 'done' | 'error' | 'none';

export interface AgentStatus {
  agent: Actor;
  /** null for an agent-level beat. */
  ticket_key: string | null;
  state: AgentState;
  health: AgentHealth;
  message: string | null;
  progress: number | null;
  last_beat_at: Iso;
  started_at: Iso;
  ended_at: Iso | null;
}

// ───────────────────────── events ─────────────────────────

export type EventType =
  | 'assigned'
  | 'unassigned'
  | 'mentioned'
  | 'comment'
  | 'stage'
  | 'updated'
  | 'created'
  | 'question_answered'
  | 'question_cancelled'
  | 'state'
  | 'dueSoon'
  | 'overdue'
  | 'invited'
  | 'question'
  | 'agentSilence';

/** One inbox event. Its `id` doubles as the cursor: ids sort by time. */
export interface TmEvent {
  id: string;
  type: EventType;
  board: BoardRef;
  ticket_id: string | null;
  ticket_key: string | null;
  message_id: string | null;
  actor: Actor | null;
  summary: string;
  created_at: Iso;
  acked_at: Iso | null;
  /**
   * `question_answered` / `question_cancelled` carry the question and, for an
   * answer, its values keyed by field id — so acting on the event needs no
   * second call. Absent on every other type.
   */
  question?:
    | {
        id: string;
        title: string;
        status: QuestionStatus;
        values?: Record<string, QuestionValue> | undefined;
        comment?: string | null | undefined;
        answered_by?: Actor | undefined;
      }
    | null
    | undefined;
}

// ───────────────────────── identity ─────────────────────────

/** `GET /v1/me` — who this token is. */
export interface Me {
  principal: {
    kind: PrincipalKind;
    id: string;
    name: string;
    /** null for agents. */
    email: string | null;
    avatar_url: string | null;
    /** Agents: the prebuilt icon id shown when there is no picture; null for people. */
    icon: string | null;
    /** Agents only. */
    description?: string | null | undefined;
    /** Agents only: the system prompt, Markdown — load it from the token alone. */
    system_prompt?: string | undefined;
  };
  /** Agent tokens: the person who owns the agent (and the token). */
  owner: { id: string; name: string; email: string } | null;
  /**
   * §R2 — which kind of credential this is, so you never have to guess
   * whether a call must name a board:
   *   'board'   a board token: `board` is set and is the only one it reaches
   *   'account' an account token ("virtual me"): `board` is null and `boards`
   *             lists every board you are on RIGHT NOW (read at this call)
   *   'oauth'   an OAuth access token, narrowed to `boards` by its grant
   */
  kind: TokenKind;
  /** The token's board; null for credentials spanning several boards. */
  board: BoardRef | null;
  /** Credentials spanning several boards (account tokens, OAuth). */
  boards?: BoardRef[] | undefined;
  role: BoardRole | null;
  scopes: Scope[];
  via: 'api' | 'mcp' | 'integration';
  token: {
    id: string;
    name: string;
    prefix: string;
    expires_at: Iso | null;
    kind: 'board' | 'account';
  } | null;
}

/** What `tm.kind()` answers (§R2). */
export type TokenKind = 'board' | 'account' | 'oauth';

// ───────────────────────── list envelopes ─────────────────────────

/** `{ data, next_cursor }` — pass `next_cursor` back as `cursor`. */
export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

/** The event feed adds `has_more`, so a poller knows to come straight back. */
export interface EventPage extends Page<TmEvent> {
  has_more: boolean;
}

export interface SearchHit {
  id: string;
  key: string;
  title: string;
  board_key: string;
  state: string;
}

// ───────────────────────── webhooks ─────────────────────────

export type WebhookEvent =
  | 'ticket.created'
  | 'ticket.updated'
  | 'ticket.moved'
  | 'ticket.state'
  | 'ticket.deleted'
  | 'message.created'
  | 'message.pinned'
  | 'board.updated'
  | 'member.joined';

/** A board webhook, for push-style orchestrators (needs `webhooks:manage`). */
export interface Webhook {
  id: string;
  /** Board KEY. */
  board: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  failures: number;
  created_at: Iso;
}

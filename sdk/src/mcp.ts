/**
 * mcpTools — build the MCP tool list YOU want out of a client (§M, "Bring
 * your own MCP server").
 *
 * Rather than handing an agent the whole /mcp endpoint, an orchestrator picks
 * the tools it wants, renames them, describes them in its own words, pins
 * arguments the model must not choose, and wraps the ones it wants to police:
 *
 *   const tools = mcpTools(tm, {
 *     only: ['get_ticket', 'post_message', 'heartbeat'],
 *     rename: { post_message: 'reply' },
 *     defaults: { ticket: 'ENG-42' },
 *     wrap: { reply: (call) => (args) => call({ ...args, markdown: prefix + args.markdown }) },
 *   })
 *   registerTools(new McpServer({ name: 'my-orch', version: '1' }), tools)
 *
 * What comes back is plain data — `{ name, description, inputSchema, handler }`
 * with a JSON Schema, no zod — so it drops into any MCP server. The tools the
 * token's scopes already forbid are dropped, so a model is never offered
 * something that must fail; the server still checks, of course.
 *
 * Each tool's name, description and scopes are the same ones /mcp publishes
 * (shared/api/mcp.ts); `test/mcp.test.ts` compares them item by item, so the
 * two lists cannot drift apart.
 */
import type { RunReceiptInput, TmClientBase } from './client.js';
import type { Scope, TicketState } from './types.js';

/** A JSON Schema (draft 2020-12) object, as MCP's `tools/list` wants it. */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
  $schema?: string;
  [key: string]: unknown;
}

/** One tool, ready for any MCP server. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Runs the tool. Returns plain JSON — `registerTools` does the MCP wrapping. */
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  /** The scopes the token needs; `[]` = any token. */
  scopes: readonly Scope[];
  /** True when the tool only reads — useful for MCP annotations. */
  readOnly: boolean;
  /** The tool's name before `rename`, so a wrapper can tell what it wrapped. */
  originalName: McpToolName;
}

export type McpToolName =
  | 'whoami'
  | 'list_boards'
  | 'get_board'
  | 'list_my_tickets'
  | 'search_tickets'
  | 'get_ticket'
  | 'get_messages'
  | 'create_ticket'
  | 'update_ticket'
  | 'move_ticket'
  | 'assign_ticket'
  | 'post_message'
  | 'upload_file'
  | 'read_file'
  | 'link_tickets'
  | 'get_events'
  | 'ack_events'
  | 'ask_question'
  | 'get_question'
  | 'cancel_question'
  | 'set_tasklist'
  | 'update_task_item'
  | 'delete_tasklist'
  | 'heartbeat';

export interface McpToolsOptions {
  /** Keep only these (names BEFORE rename). */
  only?: readonly McpToolName[];
  /** Drop these (names BEFORE rename). */
  exclude?: readonly McpToolName[];
  /** `{ post_message: 'reply' }` — what the model sees it called. */
  rename?: Partial<Record<McpToolName, string>>;
  /** `{ reply: 'Reply to the ticket…' }` — keyed by the name the model sees. */
  describe?: Record<string, string>;
  /**
   * Arguments the model never passes and cannot change. A key is applied to
   * every tool that has a property of that name; `ticket` also fills the
   * `key` argument, since most tools call it that.
   */
  defaults?: Record<string, unknown>;
  /** `{ reply: (call) => (args) => call({ …args }) }` — keyed by the name the model sees. */
  wrap?: Record<
    string,
    (
      call: (args: Record<string, unknown>) => Promise<unknown>,
    ) => (args: Record<string, unknown>) => Promise<unknown>
  >;
  /**
   * The token's scopes. Left out, they are read once from `GET /v1/me` — which
   * is why this returns a promise.
   */
  scopes?: readonly Scope[];
  /** Keep every tool, whatever the scopes say. */
  skipScopeFilter?: boolean;
}

// ───────────────────────── the schema vocabulary ─────────────────────────

const str = (
  description?: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'string',
  ...(description ? { description } : {}),
  ...extra,
});
const bool = (description?: string): Record<string, unknown> => ({
  type: 'boolean',
  ...(description ? { description } : {}),
});
const num = (
  description?: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'number',
  ...(description ? { description } : {}),
  ...extra,
});
const int = (
  description?: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ ...num(description, extra), type: 'integer' });
const list = (
  items: Record<string, unknown>,
  description?: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'array',
  items,
  ...(description ? { description } : {}),
  ...extra,
});
const record = (description?: string): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: true,
  ...(description ? { description } : {}),
});
const enumOf = (values: readonly string[], description?: string): Record<string, unknown> => ({
  type: 'string',
  enum: [...values],
  ...(description ? { description } : {}),
});

const RUN_OUTCOMES = ['review', 'waiting', 'blocked', 'failed', 'stopped', 'timeout'] as const;
/** The turn receipt (§Y1), as the wire states it — the same object post_message takes on /mcp. */
const RUN_RECEIPT: Record<string, unknown> = {
  type: 'object',
  description:
    'Orchestrators only: the receipt for one finished run of the agent. cost_usd is THIS turn; ' +
    'it is added to the ticket, board and day cost counters.',
  properties: {
    n: int('Your run counter on this ticket, 1-based', { minimum: 1 }),
    outcome: enumOf(RUN_OUTCOMES),
    cost_usd: num('This turn, in USD', { minimum: 0 }),
    session_usd: { ...num('The resumed session\'s running total, as reported', { minimum: 0 }), nullable: true },
    duration_ms: int(undefined, { minimum: 0 }),
    api_turns: { ...int(undefined, { minimum: 0 }), nullable: true },
    model: { ...str(undefined, { maxLength: 80 }), nullable: true },
    usage: {
      type: 'object',
      nullable: true,
      properties: {
        input: int(undefined, { minimum: 0 }),
        output: int(undefined, { minimum: 0 }),
        cache_read: int(undefined, { minimum: 0 }),
        cache_write: int(undefined, { minimum: 0 }),
      },
      required: ['input', 'output', 'cache_read', 'cache_write'],
      additionalProperties: false,
    },
  },
  required: ['n', 'outcome', 'cost_usd', 'session_usd', 'duration_ms', 'api_turns', 'model', 'usage'],
  additionalProperties: false,
};

/** The wire receipt → the client's camelCase input. */
function runFromWire(r: Record<string, unknown>): RunReceiptInput {
  const usage = r.usage as Record<string, number> | null | undefined;
  return {
    n: r.n as number,
    outcome: r.outcome as RunReceiptInput['outcome'],
    costUsd: r.cost_usd as number,
    sessionUsd: (r.session_usd as number | null | undefined) ?? null,
    durationMs: r.duration_ms as number,
    apiTurns: (r.api_turns as number | null | undefined) ?? null,
    model: (r.model as string | null | undefined) ?? null,
    usage: usage
      ? {
          input: usage.input!,
          output: usage.output!,
          cacheRead: usage.cache_read!,
          cacheWrite: usage.cache_write!,
        }
      : null,
  };
}

const KEY = str("Ticket key, e.g. 'ENG-42'");
const BOARD = str("Board key, e.g. 'ENG' — only needed when your credential spans several boards");
const PRINCIPAL = str("A member: 'me', an id, an email, or an agent's name");
const ISO = str("ISO date or datetime, e.g. '2026-09-24' or '2026-09-24T17:00:00Z'");
const STAGE = str('Stage name or id');
const CURSOR = str('Opaque cursor from a previous call');
const FILE_IDS = list(str(), 'File ids from upload_file, already on this ticket', { maxItems: 20 });
const TICKET_STATES = ['active', 'archived', 'cancelled'] as const;
const TASK_STATUSES = ['todo', 'doing', 'done', 'skipped', 'failed'] as const;
const AGENT_STATES = ['working', 'idle', 'done', 'error'] as const;

const schema = (
  properties: Record<string, Record<string, unknown>>,
  required: string[] = [],
): JsonSchema => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

/** One field of an `ask_question` form. */
const QUESTION_FIELD: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: str('A short id you will read the answer back under'),
    label: str('What to show the person'),
    type: enumOf(['single', 'multi', 'text', 'longText', 'number', 'boolean', 'date']),
    options: list(
      {
        type: 'object',
        properties: { id: str(), label: str(), description: str() },
        required: ['id', 'label'],
        additionalProperties: false,
      },
      'single / multi choices',
    ),
    required: bool(),
    placeholder: str(),
  },
  required: ['id', 'label', 'type'],
  additionalProperties: false,
};

const TASK_ITEM: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: str('Keep an id to keep that item across a replace'),
    title: str(),
    status: enumOf(TASK_STATUSES, "Default 'todo'"),
    note: str(),
  },
  required: ['title'],
  additionalProperties: false,
};

// ───────────────────────── the catalogue ─────────────────────────

/**
 * A tool's arguments as they arrive from a model: JSON Schema has validated
 * the shape, so the handlers read them loosely and coerce with `s()` / `n()`
 * rather than repeating the schema in TypeScript.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolArgs = Record<string, any>;

interface ToolDef {
  description: string;
  readOnly: boolean;
  scopes: readonly Scope[];
  inputSchema: JsonSchema;
  /** The REST call behind the tool. `a` is the model's arguments, already merged with the pinned defaults. */
  run: (tm: TmClientBase, a: ToolArgs) => Promise<unknown>;
}

const s = (v: unknown): string => String(v);
const n = (v: unknown): number | undefined =>
  v === undefined || v === null ? undefined : Number(v);

/**
 * Every tool /mcp publishes, with the REST call behind it. The names,
 * descriptions and scopes match shared/api/mcp.ts exactly (see test/mcp.test.ts).
 */
export const MCP_TOOL_DEFS: Record<McpToolName, ToolDef> = {
  whoami: {
    description:
      'Who you are: principal, board, scopes — and, for an agent, its name, description and system prompt.',
    readOnly: true,
    scopes: [],
    inputSchema: schema({}),
    run: (tm) => tm.me(),
  },
  list_boards: {
    description:
      'Boards this credential may act on. With an account-wide token this is the natural FIRST call: it lists every board ' +
      'you are on right now, and their keys are what the `board` argument takes.',
    readOnly: true,
    scopes: ['board:read'],
    inputSchema: schema({}),
    run: (tm) => tm.boards(),
  },
  get_board: {
    description:
      'The board: stages (with categories), priorities, tags, custom fields, and members (people and agents).',
    readOnly: true,
    scopes: ['board:read'],
    inputSchema: schema({ board: BOARD }),
    run: (tm) => tm.board(),
  },
  list_my_tickets: {
    description: 'Tickets assigned to you, most recently updated first.',
    readOnly: true,
    scopes: ['tickets:read'],
    inputSchema: schema({
      board: BOARD,
      stage: STAGE,
      state: enumOf(TICKET_STATES, "Default 'active'"),
      updated_since: ISO,
      limit: int(undefined, { minimum: 1, maximum: 200 }),
    }),
    run: (tm, a) =>
      tm.tickets.list({
        assignee: 'me',
        stage: a.stage,
        state: a.state as TicketState | undefined,
        updatedSince: a.updated_since,
        limit: n(a.limit),
      }),
  },
  search_tickets: {
    description: 'Find tickets by text, assignee, stage, state or dates.',
    readOnly: true,
    scopes: ['tickets:read'],
    inputSchema: schema({
      query: str(),
      board: BOARD,
      assignee: PRINCIPAL,
      stage: STAGE,
      state: enumOf(TICKET_STATES),
      due_before: ISO,
      updated_since: ISO,
      limit: int(undefined, { minimum: 1, maximum: 100 }),
    }),
    run: async (tm, a) => {
      const page = await tm.tickets.list({
        q: a.query,
        assignee: a.assignee,
        stage: a.stage,
        state: a.state as TicketState | undefined,
        updatedSince: a.updated_since,
        limit: n(a.limit),
      });
      // `due_before` has no REST filter; the page is small, so narrow it here.
      if (!a.due_before) return page;
      const cutoff = Date.parse(s(a.due_before));
      return {
        ...page,
        data: page.data.filter((t) => t.due_at !== null && Date.parse(t.due_at) < cutoff),
      };
    },
  },
  get_ticket: {
    description:
      'A ticket with fields, links, pinned messages, files and its last messages (Markdown).',
    readOnly: true,
    scopes: ['tickets:read'],
    inputSchema: schema(
      {
        key: KEY,
        messages: int('Also return the last N messages (default 20)', { minimum: 0, maximum: 100 }),
      },
      ['key'],
    ),
    run: (tm, a) => tm.tickets.get(s(a.key), { messages: n(a.messages) ?? 20 }),
  },
  get_messages: {
    description: "Page through a ticket's thread (Markdown bodies, attachments with file ids).",
    readOnly: true,
    scopes: ['comments:read'],
    inputSchema: schema(
      { key: KEY, cursor: CURSOR, limit: int(undefined, { minimum: 1, maximum: 200 }) },
      ['key'],
    ),
    run: (tm, a) => tm.messages.list(s(a.key), { cursor: a.cursor, limit: n(a.limit) }),
  },
  create_ticket: {
    description: 'Create a ticket.',
    readOnly: false,
    scopes: ['tickets:create'],
    inputSchema: schema(
      {
        board: BOARD,
        title: str(undefined, { minLength: 1, maxLength: 500 }),
        description: str('Markdown; mention people as @email, agents as @ag_…, tickets as #KEY'),
        assignees: list(PRINCIPAL),
        due: ISO,
        priority: str('Priority name'),
        stage: STAGE,
        tags: list(str()),
        fields: record('Custom fields by NAME'),
      },
      ['title'],
    ),
    run: (tm, a) =>
      tm.tickets.create({
        title: s(a.title),
        description: a.description,
        assignees: a.assignees,
        dueAt: a.due,
        priority: a.priority,
        stage: a.stage,
        tags: a.tags,
        fields: a.fields,
      }),
  },
  update_ticket: {
    description:
      'Change a ticket: title, description, stage, assignees, due date, priority, tags, fields.',
    readOnly: false,
    scopes: ['tickets:update', 'tickets:move', 'tickets:assign'],
    inputSchema: schema(
      {
        key: KEY,
        title: str(undefined, { minLength: 1, maxLength: 500 }),
        description: str('Markdown; replaces the description'),
        stage: STAGE,
        assignees: list(PRINCIPAL, 'Replaces the list; see assign_ticket to add / remove'),
        due: ISO,
        priority: str(),
        tags: list(str()),
        fields: record(),
      },
      ['key'],
    ),
    run: (tm, a) =>
      tm.tickets.update(s(a.key), {
        title: a.title,
        description: a.description,
        stage: a.stage,
        assignees: a.assignees,
        dueAt: a.due,
        priority: a.priority,
        tags: a.tags,
        fields: a.fields,
      }),
  },
  move_ticket: {
    description: 'Move a ticket to another stage.',
    readOnly: false,
    scopes: ['tickets:move'],
    inputSchema: schema({ key: KEY, stage: STAGE }, ['key', 'stage']),
    run: (tm, a) => tm.tickets.move(s(a.key), s(a.stage)),
  },
  assign_ticket: {
    description: 'Add or remove assignees (people or agents).',
    readOnly: false,
    scopes: ['tickets:assign'],
    inputSchema: schema(
      {
        key: KEY,
        add: list(PRINCIPAL, undefined, { maxItems: 50 }),
        remove: list(PRINCIPAL, undefined, { maxItems: 50 }),
      },
      ['key'],
    ),
    run: (tm, a) => tm.tickets.assign(s(a.key), { add: a.add, remove: a.remove }),
  },
  post_message: {
    description:
      "Post a Markdown message in a ticket's thread, optionally with files from upload_file. An orchestrator may attach `run`, the receipt of one finished run (cost, outcome, duration).",
    readOnly: false,
    scopes: ['comments:write'],
    inputSchema: schema(
      {
        key: KEY,
        markdown: str('GitHub-flavoured Markdown. May be empty when attachments are given.', {
          maxLength: 100_000,
        }),
        attachments: FILE_IDS,
        reply_to: str('Message id to quote'),
        run: RUN_RECEIPT,
      },
      ['key', 'markdown'],
    ),
    run: (tm, a) =>
      tm.messages.post(s(a.key), {
        markdown: s(a.markdown ?? ''),
        attachments: a.attachments,
        replyTo: a.reply_to,
        run: a.run ? runFromWire(a.run as Record<string, unknown>) : undefined,
      }),
  },
  upload_file: {
    description:
      'Put a file on a ticket and get its fileId. Pass `text` for Markdown / HTML documents, or content_base64.',
    readOnly: false,
    scopes: ['files:write'],
    inputSchema: schema(
      {
        key: KEY,
        name: str("File name with extension, e.g. 'plan.md', 'report.html'", {
          minLength: 1,
          maxLength: 255,
        }),
        mime: str('Default: from the extension'),
        text: str('Text content (Markdown, HTML, CSV, code …). Give text OR content_base64.'),
        content_base64: str('Binary content, base64. ≤ 25 MB decoded.'),
      },
      ['key', 'name'],
    ),
    run: (tm, a) =>
      tm.files.upload(s(a.key), {
        name: s(a.name),
        mime: a.mime,
        ...(a.text !== undefined ? { text: s(a.text) } : { base64: s(a.content_base64) }),
      }),
  },
  read_file: {
    description:
      'Read a file: the text for Markdown, HTML, text, CSV, JSON and code; a short-lived download URL otherwise.',
    readOnly: true,
    scopes: ['files:read'],
    inputSchema: schema({ fileId: str(undefined, { minLength: 1 }) }, ['fileId']),
    // ?content=1 answers 422 for a binary file; its metadata (with the signed
    // URL) is the useful answer there, so fall back rather than fail.
    run: async (tm, a) => {
      try {
        return await tm.files.get(s(a.fileId), { content: true });
      } catch {
        return await tm.files.get(s(a.fileId));
      }
    },
  },
  link_tickets: {
    description: 'Link two tickets: blocks, relates or duplicates.',
    readOnly: false,
    scopes: ['tickets:update'],
    inputSchema: schema({ from: KEY, to: KEY, type: enumOf(['blocks', 'relates', 'duplicates']) }, [
      'from',
      'to',
      'type',
    ]),
    // REST has no link route: a link is a ticket patch, so read what is there
    // and send the list back with one more on it.
    run: async (tm, a) => {
      const from = await tm.tickets.get(s(a.from));
      const type = s(a.type) as 'blocks' | 'relates' | 'duplicates';
      const links = from.links
        .filter((l) => !(l.key === s(a.to) && l.type === type))
        .map((l) => ({ type: l.type as 'blocks' | 'relates' | 'duplicates', key: l.key }));
      return tm.tickets.update(s(a.from), { links: [...links, { type, key: s(a.to) }] });
    },
  },
  get_events: {
    description:
      'Your inbox: assignments, mentions, comments and changes on your tickets since a cursor.',
    readOnly: true,
    scopes: ['events:read'],
    inputSchema: schema({ cursor: CURSOR, limit: int(undefined, { minimum: 1, maximum: 200 }) }),
    run: (tm, a) => tm.events.list({ cursor: a.cursor, limit: n(a.limit) }),
  },
  ack_events: {
    description: 'Acknowledge inbox events by id, or everything up to a cursor.',
    readOnly: false,
    scopes: ['events:read'],
    inputSchema: schema({
      ids: list(str(), undefined, { minItems: 1, maxItems: 500 }),
      upTo: str('Ack everything up to and including this event id / cursor'),
    }),
    run: (tm, a) => tm.events.ack(a.ids ? (a.ids as string[]) : { upTo: s(a.upTo) }),
  },
  ask_question: {
    description:
      'Ask the people on a ticket a question with options. It appears in the thread as a form card; the answer comes back as the inbox event question_answered.',
    readOnly: false,
    scopes: ['questions:write'],
    inputSchema: schema(
      {
        key: KEY,
        title: str("What you need to know, e.g. 'Which database should the report use?'", {
          minLength: 1,
          maxLength: 300,
        }),
        body: str('Markdown context shown under the title'),
        fields: list(QUESTION_FIELD, '1–10 form fields', { minItems: 1, maxItems: 10 }),
        allow_comment: bool("Adds an 'Anything else?' box"),
        to: list(PRINCIPAL, 'Who should answer; omit to ask anyone on the board', { maxItems: 50 }),
        blocking: bool("Default true: the ticket shows 'Waiting for your answer'"),
        expires_at: ISO,
      },
      ['key', 'title', 'fields'],
    ),
    // Deliberately does NOT wait: an MCP call must answer now, and the answer
    // arrives as the inbox event question_answered.
    run: async (tm, a) =>
      tm.questions.ask(s(a.key), {
        title: s(a.title),
        body: a.body,
        fields: a.fields,
        allowComment: a.allow_comment,
        to: a.to,
        blocking: a.blocking,
        expiresAt: a.expires_at,
      }),
  },
  get_question: {
    description: 'A question you asked: its status and, once given, the answer values.',
    readOnly: true,
    scopes: ['comments:read'],
    inputSchema: schema({ id: str('The question id returned by ask_question', { minLength: 1 }) }, [
      'id',
    ]),
    run: (tm, a) => tm.questions.get(s(a.id)),
  },
  cancel_question: {
    description: 'Cancel a question you asked — the card locks and nobody is chased for it.',
    readOnly: false,
    scopes: ['questions:write'],
    inputSchema: schema({ id: str(undefined, { minLength: 1 }) }, ['id']),
    run: (tm, a) => tm.questions.cancel(s(a.id)),
  },
  set_tasklist: {
    description:
      'Publish your plan as a checklist on the ticket (create or replace the whole list).',
    readOnly: false,
    scopes: ['tasklists:write'],
    inputSchema: schema(
      {
        key: KEY,
        title: str("Your plan's name, e.g. 'Plan: add CSV export'", {
          minLength: 1,
          maxLength: 200,
        }),
        items: list(TASK_ITEM, 'The whole list — this replaces what is there', { maxItems: 100 }),
        list_id: str('Omit to create a new list; give it to replace that one', {
          minLength: 1,
          maxLength: 64,
        }),
        position: num(),
        closed: bool('true when the plan is finished'),
      },
      ['key', 'title', 'items'],
    ),
    run: (tm, a) =>
      tm.tasklists.set(s(a.key), {
        title: s(a.title),
        items: a.items ?? [],
        listId: a.list_id,
        position: n(a.position),
        closed: a.closed,
      }),
  },
  update_task_item: {
    description:
      'Tick one item off, start it, or mark it failed with a note. Cheap — call it as you work.',
    readOnly: false,
    scopes: ['tasklists:write'],
    inputSchema: schema(
      {
        key: KEY,
        list_id: str(undefined, { minLength: 1, maxLength: 64 }),
        item_id: str(undefined, { minLength: 1, maxLength: 64 }),
        status: enumOf(TASK_STATUSES),
        note: str('Why it failed, what was skipped'),
      },
      ['key', 'list_id', 'item_id'],
    ),
    run: (tm, a) =>
      tm.tasklists.item(s(a.key), s(a.list_id), s(a.item_id), { status: a.status, note: a.note }),
  },
  delete_tasklist: {
    description: 'Remove a task list from the ticket.',
    readOnly: false,
    scopes: ['tasklists:write'],
    inputSchema: schema({ key: KEY, list_id: str(undefined, { minLength: 1, maxLength: 64 }) }, [
      'key',
      'list_id',
    ]),
    run: (tm, a) => tm.tasklists.delete(s(a.key), s(a.list_id)),
  },
  heartbeat: {
    description:
      "Say what you are doing: every minute while you work, and once more when you stop ('done' or 'error'). People see a live dot on the ticket.",
    readOnly: false,
    scopes: ['status:write'],
    inputSchema: schema(
      {
        ticket: str('Omit for an agent-level beat, about no ticket in particular'),
        state: enumOf(
          AGENT_STATES,
          "'working' every minute while you work; 'idle', 'done' or 'error' when you stop",
        ),
        message: str("'Running tests (3/12)'", { maxLength: 200 }),
        progress: num(undefined, { minimum: 0, maximum: 1 }),
        board: BOARD,
      },
      ['state'],
    ),
    run: (tm, a) =>
      tm.heartbeat.send(a.state, { ticket: a.ticket, message: a.message, progress: n(a.progress) }),
  },
};

export const MCP_TOOL_NAMES = Object.keys(MCP_TOOL_DEFS) as McpToolName[];

/** Property names that all mean "the ticket", so `defaults.ticket` reaches them. */
const TICKET_ARGS = ['key', 'ticket'] as const;

/** Is this tool listed / callable for a credential with these scopes? */
export function toolAllowed(
  name: McpToolName,
  scopes: readonly Scope[] | undefined | null,
): boolean {
  const need = MCP_TOOL_DEFS[name].scopes;
  return !scopes || need.length === 0 || need.some((s2) => scopes.includes(s2));
}

/**
 * Build the tool list. Returns a promise because, unless you pass `scopes`,
 * it asks `GET /v1/me` once for them; `registerTools` takes the promise, so
 * the `await` is usually invisible.
 */
export async function mcpTools(
  tm: TmClientBase,
  options: McpToolsOptions = {},
): Promise<McpTool[]> {
  const scopes = options.skipScopeFilter ? null : (options.scopes ?? (await tm.me()).scopes);
  const only = options.only ? new Set<string>(options.only) : null;
  const exclude = new Set<string>(options.exclude ?? []);
  const defaults = options.defaults ?? {};

  const out: McpTool[] = [];
  for (const original of MCP_TOOL_NAMES) {
    if (only && !only.has(original)) continue;
    if (exclude.has(original)) continue;
    if (!options.skipScopeFilter && !toolAllowed(original, scopes)) continue;

    const def = MCP_TOOL_DEFS[original];
    const name = options.rename?.[original] ?? original;

    // Pin the defaults: take them out of the schema (the model cannot see or
    // change them) and put them back in at call time.
    const fixed: Record<string, unknown> = {};
    const properties = { ...def.inputSchema.properties };
    let required = [...(def.inputSchema.required ?? [])];
    for (const [given, value] of Object.entries(defaults)) {
      const target = properties[given]
        ? given
        : (TICKET_ARGS as readonly string[]).includes(given)
          ? TICKET_ARGS.find((p) => properties[p])
          : undefined;
      if (!target) continue;
      fixed[target] = value;
      delete properties[target];
      required = required.filter((r) => r !== target);
    }

    const call = (args: Record<string, unknown>): Promise<unknown> =>
      def.run(tm, { ...args, ...fixed });
    const wrapper = options.wrap?.[name];

    out.push({
      name,
      description: options.describe?.[name] ?? def.description,
      inputSchema: {
        ...def.inputSchema,
        properties,
        ...(required.length ? { required } : { required: undefined }),
      } as JsonSchema,
      handler: wrapper ? wrapper(call) : call,
      scopes: def.scopes,
      readOnly: def.readOnly,
      originalName: original,
    });
  }
  return out;
}

// ───────────────────────── registerTools ─────────────────────────

/** What MCP sends back for a tool call. */
export interface McpCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** The little bit of @modelcontextprotocol/sdk `registerTools` needs. */
interface LowLevelServer {
  registerCapabilities?: (capabilities: Record<string, unknown>) => void;
  fallbackRequestHandler?:
    | ((
        request: { method: string; params?: Record<string, unknown> },
        extra: unknown,
      ) => Promise<unknown>)
    | undefined;
}
interface HighLevelServer {
  server: LowLevelServer;
}
export type AnyMcpServer = LowLevelServer | HighLevelServer;

const hasInner = (s2: AnyMcpServer): s2 is HighLevelServer =>
  typeof (s2 as HighLevelServer).server === 'object' && (s2 as HighLevelServer).server !== null;

/** JSON out, MCP content in. Objects go back as pretty JSON text. */
export function toCallResult(value: unknown): McpCallResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return { content: [{ type: 'text', text }] };
}

/**
 * Serve `tools` from a @modelcontextprotocol/sdk server.
 *
 * It answers `tools/list` and `tools/call` through the server's public
 * `fallbackRequestHandler`, which needs no zod — the SDK's own
 * `registerTool()` takes zod schemas, and this package has no dependencies.
 * Call it BEFORE `server.connect()`, and do not mix it with
 * `server.registerTool()` on the same server: whoever owns `tools/list` owns
 * the whole list.
 */
export async function registerTools(
  server: AnyMcpServer,
  tools: McpTool[] | Promise<McpTool[]>,
): Promise<McpTool[]> {
  const list2 = await tools;
  const low: LowLevelServer = hasInner(server) ? server.server : server;
  low.registerCapabilities?.({ tools: { listChanged: false } });

  const byName = new Map(list2.map((t) => [t.name, t]));
  const definitions = list2.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: t.readOnly },
  }));

  const previous = low.fallbackRequestHandler;
  low.fallbackRequestHandler = async (request, extra) => {
    if (request.method === 'tools/list') return { tools: definitions };
    if (request.method === 'tools/call') {
      const params = (request.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const tool = params.name ? byName.get(params.name) : undefined;
      if (!tool)
        return { content: [{ type: 'text', text: `Unknown tool: ${params.name}` }], isError: true };
      try {
        return toCallResult(await tool.handler(params.arguments ?? {}));
      } catch (e) {
        // A failed tool is an answer, not a transport error: the model needs
        // to read what went wrong and try something else.
        const message = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    }
    if (previous) return previous(request, extra);
    throw new Error(`Method not found: ${request.method}`);
  };
  return list2;
}

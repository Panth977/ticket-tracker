/**
 * The type check a consumer project gets for free (§M: "its types come from
 * the same @tm/shared schemas the server validates with, so a wrong field is
 * a compile error rather than a 400").
 *
 * This file never runs. It exists to be compiled: `tsc --strict` against the
 * SDK as it arrives from the npm tarball — every method called with an
 * explicit type on the answer, so a silent `any` (the shape "no types
 * resolved" takes) fails to compile just as loudly as a wrong field.
 *
 * The second half is the other direction: every `@ts-expect-error` below is
 * a mistake the compiler MUST refuse. If one of them starts compiling, TypeScript
 * reports the unused directive and this file fails — which is also what
 * happens if the types never resolved at all, because then nothing is an
 * error any more. "No types" therefore cannot pass as "types fine".
 *
 * Run by `node qaqc/orch-sample/check.mjs` (root: `pnpm orch:sample`).
 */
import {
  createClient,
  isTmError,
  mcpTools,
  registerTools,
  toBase64,
  HEARTBEAT_INTERVAL_MS,
  TmError,
  VERSION,
  type AgentStatus,
  type Beat,
  type Board,
  type EventPage,
  type FileWithContent,
  type McpTool,
  type Me,
  type Message,
  type Page,
  type Question,
  type Scope,
  type SearchHit,
  type Tasklist,
  type Ticket,
  type TicketDetail,
  type TmClient,
  type TmEvent,
  type TmFile,
  type UploadedFile,
  type LiveCredential,
  type Watcher,
  type WatchSignal,
  type Webhook,
  type WorkSummary,
} from '@tm/sdk';

const KEY = 'ENG-42';

const tm: TmClient = createClient({
  token: process.env.TM_TOKEN ?? 'tm_live_example',
  baseUrl: 'https://taskmanager-example.web.app',
  retry: { retries: 3, baseMs: 250, maxMs: 10_000 },
  timeoutMs: 30_000,
  userAgent: 'every-method/1.0',
});

// ── identity, board, search ─────────────────────────────────────────────────

export async function identity(): Promise<void> {
  const me: Me = await tm.me();
  const who: string = me.principal.name;
  const prompt: string | undefined = me.principal.system_prompt;
  const scopes: Scope[] = me.scopes;
  const owner: string | null = me.owner?.name ?? null;

  const board: Board = await tm.board();
  const stages: string[] = board.stages.map((s) => s.name);
  const boards: Page<Board> = await tm.boards();
  const hits: SearchHit[] = (await tm.search('csv export', { limit: 5 })).data;

  const sdk: string = VERSION;
  const base: string = tm.baseUrl;
  void [
    who,
    prompt,
    scopes,
    owner,
    stages,
    boards.next_cursor,
    hits,
    sdk,
    base,
    HEARTBEAT_INTERVAL_MS,
  ];
}

// ── tickets ─────────────────────────────────────────────────────────────────

export async function tickets(): Promise<void> {
  const page: Page<Ticket> = await tm.tickets.list({
    assignee: 'me',
    state: 'active',
    stage: 'Doing',
    q: 'csv',
    limit: 20,
  });
  const first: Ticket | undefined = page.data[0];
  for await (const t of tm.tickets.iterate({ updatedSince: '2026-01-01T00:00:00.000Z' })) {
    const key: string = t.key;
    void key;
    break;
  }

  const detail: TicketDetail = await tm.tickets.get(KEY, { messages: 10 });
  const due: string | null = detail.due_at;
  const created: Ticket = await tm.tickets.create({
    title: 'Add CSV export',
    description: 'From the sample',
    tags: ['api'],
  });
  const patched: Ticket = await tm.tickets.update(KEY, {
    fields: { Component: 'exporter' },
    dueAt: null,
    estimate: 3,
  });
  const moved: Ticket = await tm.tickets.move(KEY, 'Review');
  // No `reason`: a ticket is active or archived, and deleting is deleting (decision D13/D14).
  const archived: Ticket = await tm.tickets.state(KEY, 'archived');
  const assigned: Ticket = await tm.tickets.assign(KEY, {
    add: ['me'],
    remove: ['ada@example.com'],
  });
  void [first, due, created, patched, moved, archived, assigned];
}

// ── messages, files ─────────────────────────────────────────────────────────

export async function documents(): Promise<void> {
  const thread: Page<Message> = await tm.messages.list(KEY, { order: 'desc', limit: 50 });
  const md: UploadedFile = await tm.files.upload(KEY, { name: 'report.md', text: '# hi' });
  const bin: UploadedFile = await tm.files.upload(KEY, {
    name: 'x.pdf',
    bytes: new Uint8Array([0x25, 0x50]),
  });
  const b64: UploadedFile = await tm.files.upload(KEY, {
    name: 'y.png',
    base64: toBase64(new Uint8Array([1, 2, 3])),
    mime: 'image/png',
  });
  const posted: Message = await tm.messages.post(KEY, {
    markdown: 'Done.',
    attachments: [md.id, bin.id],
    replyTo: thread.data[0]?.id,
  });
  const files: TmFile[] = (await tm.files.list(KEY)).data;
  const one: FileWithContent = await tm.files.get(md.file_id, { content: true });
  const text: string = await tm.files.read(md.id);
  void [posted.via_token, files, one.content_truncated, text, b64];
}

// ── questions ───────────────────────────────────────────────────────────────

export async function questions(): Promise<void> {
  const asking = tm.questions.ask(KEY, {
    title: 'Which database?',
    body: 'Both are wired up.',
    blocking: true,
    allowComment: true,
    to: ['ada@example.com'],
    expiresAt: '2026-12-31T00:00:00.000Z',
    fields: [
      {
        id: 'db',
        label: 'Database',
        type: 'single',
        options: ['Postgres', 'SQLite'],
        required: true,
      },
      { id: 'regions', label: 'Regions', type: 'multi', options: [{ id: 'eu', label: 'EU' }] },
      { id: 'urgent', label: 'Urgent?', type: 'boolean' },
      { id: 'size', label: 'How many rows?', type: 'number', default: 100 },
      { id: 'when', label: 'By when?', type: 'date' },
      { id: 'why', label: 'Why?', type: 'text', placeholder: 'one line' },
    ],
  });
  const asked: Question = await asking;
  const answer = await asking.waitForAnswer({ timeoutMs: 60_000, pollMs: 1_000 });

  // Each value is typed from the field that produced it (§M).
  const db: string = answer.values.db;
  const regions: string[] = answer.values.regions;
  const urgent: boolean = answer.values.urgent;
  const size: number = answer.values.size;
  const when: number = answer.values.when;
  const comment: string | null = answer.comment;

  const fetched: Question = await tm.questions.get(asked.id);
  const again = await tm.questions.waitForAnswer<typeof asked.fields>(asked.id, { pollMs: 500 });
  const cancelled: Question = await tm.questions.cancel(asked.id);
  void [db, regions, urgent, size, when, comment, fetched.status, again.at, cancelled.status];
}

// ── task lists, heartbeat, agent status ─────────────────────────────────────

export async function progress(): Promise<void> {
  const plan: Tasklist = await tm.tasklists.set(KEY, {
    listId: 'plan',
    title: 'Plan: add CSV export',
    position: 0,
    items: ['Read the spec', { id: 'write', title: 'Write it', status: 'doing', note: 'halfway' }],
  });
  const lists: Tasklist[] = (await tm.tasklists.list(KEY)).data;
  const ticked: Tasklist = await tm.tasklists.item(KEY, plan.id, 'write', {
    status: 'done',
    note: null,
  });
  const gone: { deleted: true } = await tm.tasklists.delete(KEY, plan.id);

  const beat: Beat = tm.heartbeat.start({
    ticket: KEY,
    message: 'Running tests',
    progress: 0.1,
    everyMs: 60_000,
  });
  const working: AgentStatus = await beat.update({
    message: 'Writing the report',
    progress: 0.8,
    state: 'idle',
  });
  const running: boolean = beat.running;
  beat.stop();
  const finished: AgentStatus = await beat.done({ message: 'All green' });
  const failed: AgentStatus = await beat.error('the build broke');
  const oneOff: AgentStatus = await tm.heartbeat.send('working', {
    ticket: KEY,
    message: 'by hand',
    progress: null,
  });
  const board: AgentStatus[] = (await tm.agents.status({ ticket: KEY })).data;
  void [
    lists,
    ticked.progress.done,
    gone.deleted,
    working.health,
    running,
    finished.ended_at,
    failed.state,
    oneOff.last_beat_at,
    board,
  ];
}

// ── waking instead of polling (§W) ──────────────────────────────────────────

export async function cheapLoop(): Promise<void> {
  // ONE held connection to the Realtime Database; nothing on the wire while
  // nothing is happening. Falls back to a backoff poll where it cannot open.
  const watcher: Watcher = tm.watch({ target: 'auto', minPollMs: 2_000, maxPollMs: 60_000 });
  const where: readonly string[] = watcher.paths;
  const how: 'stream' | 'poll' = watcher.source;
  const why: string | null = watcher.degraded;

  let cursor: string | undefined;
  let rounds = 0;
  for await (const signal of watcher) {
    const s: WatchSignal = signal;
    if (s.reason === 'poll') void s.board;
    // Every fetch after a wake asks for the DELTA, never for the world.
    const delta: EventPage = await tm.events.list({ cursor, unacked: true });
    cursor = delta.next_cursor ?? cursor;
    watcher.found(delta.data.length);

    const changed: Ticket[] = await tm.tickets.changes();
    const mark: string | undefined = tm.tickets.watermark();
    void [changed.length, mark];
    if (++rounds > 0) break; // this file is compiled, never run
  }
  watcher.stop();
  void cursor;

  // The credential the stream is opened with, when the API mints one.
  const credential: Promise<LiveCredential> = tm.live();
  void credential.catch(() => void 0);
  void [where.length, how, why];
}

// ── events, the work loop, webhooks and the escape hatch ────────────────────

export async function loop(): Promise<void> {
  const page: EventPage = await tm.events.list({ limit: 100, unacked: true });
  const more: boolean = page.has_more;
  const acked: { acked: number } = await tm.events.ack(page.data.map((e) => e.id));
  const upTo: { acked: number } = await tm.events.ack({ upTo: page.next_cursor ?? '' });

  for await (const ev of tm.events.stream({ ack: true, reconnectMs: 1_000, maxReconnects: 3 })) {
    const e: TmEvent = ev;
    if (e.type === 'question_answered') {
      const values = e.question?.values;
      void values;
    }
    break;
  }

  const summary: WorkSummary = await tm.work(
    async ({ ticket, event, tm: client, beat, signal }) => {
      const key: string | null = ticket;
      const kind: TmEvent['type'] = event.type;
      await beat?.update({ message: `Handling ${kind}` });
      if (key) await client.messages.post(key, { markdown: 'On it.' }, { signal });
    },
    {
      concurrency: 2,
      filter: ['assigned', 'mentioned'],
      max: 10,
      heartbeat: { everyMs: 30_000 },
      ack: true,
      // The default. 'stream' holds /v1/events/stream open, which is billed
      // for every second it is open — see §4.5 of the integration context.
      transport: 'watch',
      watch: { minPollMs: 2_000, maxPollMs: 60_000 },
    },
  );

  const hooks: Page<Webhook> = await tm.webhooks.list();
  const hook = await tm.webhooks.create({
    board: 'ENG',
    url: 'https://example.test/hook',
    events: ['ticket.created'],
  });
  const rotated = await tm.webhooks.update(hook.id, { active: false, rotate_secret: true });
  await tm.webhooks.delete(hook.id);

  // Anything /v1 grows that the SDK has not wrapped yet, same retries and errors.
  const raw: { ok: boolean } = await tm.request<{ ok: boolean }>('GET', '/whatever', {
    query: { limit: 1 },
    timeoutMs: 5_000,
  });
  void [
    more,
    acked.acked,
    upTo.acked,
    summary.handled,
    hooks.data,
    rotated.secret,
    raw.ok,
    tm.http.baseUrl,
  ];
}

// ── errors ──────────────────────────────────────────────────────────────────

export async function errors(): Promise<void> {
  try {
    await tm.tickets.move(KEY, 'QA');
  } catch (e) {
    if (isTmError(e)) {
      const code: string = e.code;
      const status: number = e.status;
      const missing: Scope[] = e.missingScopes;
      const retryable: boolean = e.retryable;
      void [code, status, missing, retryable];
    }
    if (e instanceof TmError) void e.problem?.code;
  }
}

// ── the MCP tool factory ────────────────────────────────────────────────────

export async function tools(): Promise<void> {
  const built: McpTool[] = await mcpTools(tm, {
    only: [
      'get_ticket',
      'post_message',
      'set_tasklist',
      'update_task_item',
      'ask_question',
      'heartbeat',
    ],
    exclude: ['delete_tasklist'],
    rename: { post_message: 'reply' },
    describe: { reply: 'Reply to the ticket you are working on. Markdown.' },
    defaults: { ticket: KEY },
    wrap: {
      reply: (call) => (args) => call({ ...args, markdown: `[sample] ${String(args.markdown)}` }),
    },
    scopes: ['tickets:read', 'comments:write'],
  });
  const names: string[] = built.map((t) => t.name);
  const schema: unknown = built[0]?.inputSchema;
  const out: unknown = await built[0]?.handler({ key: KEY });
  await registerTools({ registerCapabilities: () => void 0 }, built);
  void [names, schema, out];
}

// ── every one of these must FAIL to compile ─────────────────────────────────

// @ts-expect-error a client needs a token
createClient({});
// @ts-expect-error a token is a string, not a number
createClient({ token: 42 });
// @ts-expect-error there is no `apiKey` option
createClient({ token: 'tm_live_x', apiKey: 'x' });
// @ts-expect-error move() needs the stage to move to
void tm.tickets.move(KEY);
// @ts-expect-error 'deleted' is not a ticket state
void tm.tickets.state(KEY, 'deleted');
// @ts-expect-error a title is required to create a ticket
void tm.tickets.create({ description: 'no title' });
// @ts-expect-error tags are names, not objects
void tm.tickets.update(KEY, { tags: [{ name: 'api' }] });
// @ts-expect-error the SDK takes `markdown`, not the wire's `body_markdown`
void tm.messages.post(KEY, { body_markdown: 'x' });
// @ts-expect-error a file needs a name
void tm.files.upload(KEY, { text: 'x' });
// @ts-expect-error bytes are binary, not a string
void tm.files.upload(KEY, { name: 'x.bin', bytes: 'not bytes' });
// @ts-expect-error 'nope' is not a task item status
void tm.tasklists.item(KEY, 'l1', 'i1', { status: 'nope' });
// @ts-expect-error a task list needs a title
void tm.tasklists.set(KEY, { items: ['a'] });
// @ts-expect-error 'dropdown' is not a question field type
void tm.questions.ask(KEY, { title: 'q', fields: [{ id: 'a', label: 'A', type: 'dropdown' }] });
// @ts-expect-error 'sleeping' is not an agent state
void tm.heartbeat.send('sleeping', { ticket: KEY });
// @ts-expect-error progress is a number
void tm.heartbeat.start({ ticket: KEY, progress: 'most of the way' });
// @ts-expect-error 'exploded' is not an event type to filter on
void tm.work(async () => void 0, { filter: ['exploded'] });
// @ts-expect-error there is no 'sse' transport — it is 'watch' or 'stream'
void tm.work(async () => void 0, { transport: 'sse' });
// @ts-expect-error a watcher listens to a known target
void tm.watch({ target: 'everything' });
// @ts-expect-error found() counts rows, it is not a boolean
void tm.watch().found(true);
// @ts-expect-error there is no such tool
void mcpTools(tm, { only: ['delete_ticket'] });
// @ts-expect-error a webhook's events are the documented ones
void tm.webhooks.create({ board: 'ENG', url: 'https://example.test', events: ['ticket.exploded'] });

export async function wrongTypes(): Promise<void> {
  // @ts-expect-error a principal's name is a string, not a number
  const name: number = (await tm.me()).principal.name;
  // @ts-expect-error a ticket key is a string
  const key: boolean = (await tm.tickets.get(KEY)).key;
  // @ts-expect-error progress counts, it is not a string
  const done: string = (await tm.tasklists.list(KEY)).data[0]!.progress.done;
  // @ts-expect-error a 'single' answer is a string, not a list
  const db: string[] = (
    await tm.questions
      .ask(KEY, { title: 'q', fields: [{ id: 'db', label: 'D', type: 'single' }] })
      .waitForAnswer()
  ).values.db;
  void [name, key, done, db];
}

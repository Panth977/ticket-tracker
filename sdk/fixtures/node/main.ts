/**
 * A Node consumer of the npm tarball, type-checked with `tsc --strict`.
 *
 * This file is the proof §M asks for: that `npm i …/tm-sdk.tgz` gives an
 * editor and a compiler the real types. The first half uses the SDK the way
 * an orchestrator would, with explicit annotations so a silent `any` fails to
 * compile; the second half is a list of mistakes the compiler MUST refuse —
 * each `@ts-expect-error` is itself an error if the line turns out to be
 * fine, so "no types resolved at all" cannot pass either way.
 */
import {
  createClient,
  isTmError,
  mcpTools,
  registerTools,
  serverTime,
  TmError,
  type Board,
  type Me,
  type Scope,
  type Ticket,
  type TicketDetail,
  type TmEvent,
  type TmClient,
  type McpTool,
} from '@tm/sdk';

const tm: TmClient = createClient({
  token: 'tm_live_example',
  baseUrl: 'https://taskmanager-example.web.app',
});

export async function orchestrate(): Promise<void> {
  const me: Me = await tm.me();
  const who: string = me.principal.name;
  const scopes: Scope[] = me.scopes;
  const prompt: string | undefined = me.principal.system_prompt;

  const board: Board = await tm.board();
  const stageNames: string[] = board.stages.map((s) => s.name);

  const mine = await tm.tickets.list({ assignee: 'me', state: 'active' });
  const first: Ticket | undefined = mine.data[0];
  const detail: TicketDetail = await tm.tickets.get('ENG-42', { messages: 20 });
  const due: string | null = detail.due_at;

  await tm.tasklists.set('ENG-42', {
    title: 'Plan',
    items: ['Read the spec', 'Write it', 'Test it'],
  });
  await tm.tasklists.item('ENG-42', 'list-1', 'item-1', { status: 'doing' });

  const report = await tm.files.upload('ENG-42', { name: 'report.html', text: '<h1>done</h1>' });
  await tm.messages.post('ENG-42', {
    markdown: 'Done — see the report.',
    attachments: [report.id],
  });

  // The answer's values are typed from the fields that were passed.
  const answer = await tm.questions
    .ask('ENG-42', {
      title: 'Which database?',
      blocking: true,
      fields: [
        {
          id: 'db',
          label: 'Database',
          type: 'single',
          options: ['Postgres', 'SQLite'],
          required: true,
        },
        { id: 'urgent', label: 'Urgent?', type: 'boolean' },
      ],
    })
    .waitForAnswer({ timeoutMs: 30 * 60_000 });
  const db: string = answer.values.db;
  const urgent: boolean = answer.values.urgent;

  const beat = tm.heartbeat.start({ ticket: 'ENG-42', message: 'Running tests' });
  await beat.update({ message: 'Writing the report', progress: 0.8 });
  await beat.done();

  for await (const ev of tm.events.stream({ ack: true })) {
    const summary: string = ev.summary;
    if (ev.type === 'assigned') void summary;
    break;
  }

  await tm.work(
    async ({ ticket, event, beat: running, tm: client }) => {
      const key: string | null = ticket;
      const e: TmEvent = event;
      await running?.update({ message: `Handling ${e.type}` });
      if (key) await client.messages.post(key, { markdown: 'On it.' });
    },
    { concurrency: 2, filter: ['assigned', 'mentioned'] },
  );

  const tools: McpTool[] = await mcpTools(tm, {
    only: ['get_ticket', 'post_message', 'heartbeat'],
    rename: { post_message: 'reply' },
    describe: { reply: 'Reply to the ticket you are working on. Markdown.' },
    defaults: { ticket: 'ENG-42' },
    wrap: {
      reply: (call) => (args) => call({ ...args, markdown: `[bot] ${String(args.markdown)}` }),
    },
  });
  await registerTools({ registerCapabilities: () => void 0 }, tools);

  try {
    await tm.tickets.move('ENG-42', 'QA');
  } catch (e) {
    if (isTmError(e)) {
      const code: string = e.code;
      const status: number = e.status;
      const missing: Scope[] = e.missingScopes;
      void [code, status, missing];
    }
    if (e instanceof TmError) void e.problem;
  }

  // §AA4 — an artifact's data from outside the page: Date in, Date out.
  const data = tm.artifacts.data('art1');
  const doc = await data.firestore.get<{ at: Date; total: number }>('scores/2026');
  const at: Date | undefined = doc.data?.at;
  await data.firestore.set(
    'scores/2026',
    { total: 1, at: new Date(), seen: serverTime },
    { merge: true },
  );
  const page = await data.firestore.list('scores', {
    where: [['total', '>', 1]],
    orderBy: ['total', 'desc'],
    limit: 10,
  });
  const next: string | null = page.nextCursor;
  for await (const d of data.firestore.listAll('scores')) void d.id;
  await data.firestore.batch([
    { op: 'set', path: 'a/b', data: {} },
    { op: 'delete', path: 'a/c' },
  ]);
  const file = await data.files.upload('x.csv', 'a,b', { contentType: 'text/csv' });
  const size: number = file.size;
  // §AA3 — an agent on an artifact: build and data, separately.
  await tm.artifacts.share('art1', {
    agent: 'ag_0123456789abcdef',
    access: { build: false, data: 'write' },
  });
  // §AA1 — name the board; an agent may be an admin.
  const eng = createClient({ token: 'tm_live_x', board: 'ENG' });
  await eng.boards.setAgent('ENG', { agent: 'ag_0123456789abcdef', role: 'admin' });
  const isAgent: boolean = (await tm.kind()) === 'agent';

  void [who, scopes, prompt, stageNames, first, due, db, urgent, tools, at, next, size, isAgent];
}

// ── the compiler must refuse every one of these ─────────────────────────────

// @ts-expect-error a client needs a token
createClient({});
// @ts-expect-error a token is a string
createClient({ token: 42 });
// @ts-expect-error move() needs the stage to move to
void tm.tickets.move('ENG-42');
// @ts-expect-error 'deleted' is not a ticket state
void tm.tickets.state('ENG-42', 'deleted');
// @ts-expect-error the SDK takes `markdown`, not the wire's `body_markdown`
void tm.messages.post('ENG-42', { body_markdown: 'x' });
// @ts-expect-error 'nope' is not a task item status
void tm.tasklists.item('ENG-42', 'l1', 'i1', { status: 'nope' });
// @ts-expect-error a file needs a name
void tm.files.upload('ENG-42', { text: 'x' });
// @ts-expect-error there is no such tool
void mcpTools(tm, { only: ['delete_ticket'] });
// @ts-expect-error a principal's name is a string
export const wrongType: number = (await tm.me()).principal.name;
// @ts-expect-error a batch write needs a known op
void tm.artifacts.data('art1').firestore.batch([{ op: 'upsert', path: 'a/b', data: {} }]);
// @ts-expect-error '~' is not a filter operator
void tm.artifacts.data('art1').firestore.list('scores', { where: [['total', '~', 1]] });
// @ts-expect-error an agent's data access is 'none' | 'read' | 'write'
void tm.artifacts.share('art1', {
  agent: 'ag_0123456789abcdef',
  access: { build: true, data: 'admin' },
});

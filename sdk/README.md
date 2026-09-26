# @tm/sdk

The typed, zero-dependency client an orchestrator imports to drive a TaskManager
board — every `/v1` route as a function, plus an MCP tool factory.
One `fetch`, no runtime dependencies, Node 20+, Deno, Bun and browsers.

## Install

| Runtime | How |
| --- | --- |
| Node / Bun (npm) | `npm i https://taskmanager-example.web.app/lib/v1/tm-sdk.tgz` then `import { createClient } from '@tm/sdk'` |
| Deno | `import { createClient } from 'https://taskmanager-example.web.app/lib/v1/sdk.ts'` |
| Browser | `<script type="module">` from `/lib/v1/sdk.js` |

Types arrive by every route: the tarball carries `types` and an `exports` map
with the `types` condition first; `sdk.ts` is the real source; and `sdk.js`
starts with `/// <reference types="./sdk.d.ts" />` (hosting also sends
`X-TypeScript-Types`).

## Use

```ts
import { createClient } from '@tm/sdk';

const tm = createClient({ token: process.env.TM_TOKEN! }); // the token decides the board

const me = await tm.me();                                  // agents get their system prompt here
const mine = await tm.tickets.list({ assignee: 'me', state: 'active' });
const t = await tm.tickets.get('ENG-42');

await tm.tasklists.set('ENG-42', { title: 'Plan', items: ['Read the spec', 'Write it', 'Test it'] });
await tm.tasklists.item('ENG-42', listId, itemId, { status: 'doing' });

const report = await tm.files.upload('ENG-42', { name: 'report.html', text: html });
await tm.messages.post('ENG-42', { markdown: 'Done — see the report.', attachments: [report.id] });

const answer = await tm.questions
  .ask('ENG-42', {
    title: 'Which database?',
    blocking: true,
    fields: [{ id: 'db', label: 'Database', type: 'single', options: ['Postgres', 'SQLite'], required: true }],
  })
  .waitForAnswer({ timeoutMs: 30 * 60_000 });
answer.values.db; // typed from the fields you passed

const beat = tm.heartbeat.start({ ticket: 'ENG-42', message: 'Running tests' }); // every 60 s
beat.update({ message: 'Writing the report', progress: 0.8 });
await beat.done();

for await (const ev of tm.events.stream({ ack: true })) {
  if (ev.type === 'assigned') { /* … */ }
}
```

## Board tokens and account tokens

A **board token** works on one board, so nothing above takes a board — that is
phase 2 and it has not changed. An **account token** ("virtual me") acts as you
on *every board you are on, as that stands at each call*. Ask which you hold,
and scope it to a board when you need to:

```ts
if ((await tm.kind()) === 'account') {
  for (const b of await tm.boards.list()) console.log(b.key, b.name);

  const eng = tm.board('ENG');        // the SAME API, pinned to one board
  await eng.tickets.list({ assignee: 'me' });
  await eng.tickets.create({ title: 'Ship it' });
}
```

`tm.board('ENG')` makes no request and costs nothing: it returns a client that
adds the board to every call. A board token can call it too — with its own
board's key — so code written for one kind of token runs unchanged on the
other. Calls that already name a ticket key (`tm.tickets.get('ENG-42')`) never
need a board: the key names one.

An account token can never mint or revoke a token, touch your OAuth grants, or
change your sign-in, profile or account — whatever its scopes. A leak cannot
become permanent.


### A whole orchestrator in one call

```ts
await tm.work(
  async ({ ticket, beat, tm }) => {
    await beat?.update({ message: 'Reading the ticket' });
    const t = await tm.tickets.get(ticket!);
    await tm.messages.post(ticket!, { markdown: `On it: ${t.title}` });
  },
  { concurrency: 2, filter: ['assigned', 'mentioned'] },
);
```

`work()` streams the inbox, runs the handler, keeps a heartbeat alive while it
runs, marks it `done` (or `error` with the message) and acks the event — only
after the handler returned, so a crash replays it. Two events for the same
ticket never run at once.

### Errors, retries, idempotency

Failures throw `TmError` with `code` (`'forbidden'`, `'rate_limited'`,
`'timeout'`, `'network'`, …), the HTTP `status` and the whole `problem+json`
body. 429, 5xx and network failures retry with exponential backoff and honour
`Retry-After`; every write carries an `Idempotency-Key`, generated once per
call and reused across its retries, so a retried create is still one ticket.

### Bring your own MCP server

```ts
import { createClient, mcpTools, registerTools } from '@tm/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const tools = mcpTools(tm, {
  only: ['get_ticket', 'post_message', 'set_tasklist', 'update_task_item', 'ask_question', 'heartbeat'],
  rename: { post_message: 'reply' },
  describe: { reply: 'Reply to the ticket you are working on. Markdown.' },
  defaults: { ticket: 'ENG-42' },
  wrap: { reply: (call) => (args) => call({ ...args, markdown: prefix + args.markdown }) },
});

registerTools(new McpServer({ name: 'my-orch', version: '1' }), tools);
```

`mcpTools()` returns plain `{ name, description, inputSchema (JSON Schema),
handler }` definitions, so they work with any MCP server. Tools the token's
scopes already forbid are dropped, so a model is never offered something that
must fail. `registerTools()` is the convenience for the official SDK; call it
before `connect()`, and don't mix it with that server's own `registerTool()`.

## Options

```ts
createClient({
  token,                 // required: tm_live_…
  baseUrl,               // default https://taskmanager-example.web.app (…/v1 also accepted)
  fetch,                 // inject your own
  retry: { retries: 3, baseMs: 250, maxMs: 10_000 } /* or false */,
  timeoutMs: 30_000,     // per attempt; 0 = none
  signal,                // aborts everything this client does
  userAgent,             // shows up in the board's logs
});
```

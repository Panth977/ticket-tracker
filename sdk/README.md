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

const tm = createClient({ token: process.env.TM_TOKEN!, board: 'ENG' }); // name the board (see below)

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

## Which board: agent, account and board tokens

An **agent token** is one per agent. It says who the agent is and nothing else:
it reaches *every board the agent is on, as that stands at each call*, and what
it may do there is the agent's **role on that board** (viewer, commenter,
editor or admin) — there is no scope list to tick. An **account token**
("virtual me") is the same thing for you: every board you are on. A **board
token** acting as you still works on exactly one board.

So with an agent or account token, a board-scoped call has to say which board
it means, unless there is only one to mean. Pin it once:

```ts
const tm = createClient({ token: process.env.TM_TOKEN!, board: 'ENG' });
```

or ask what the token reaches and scope it per board:

```ts
const kind = await tm.kind();            // 'agent' | 'account' | 'board' | 'oauth'
if (kind !== 'board') {
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

A call that needed a board and got none answers 400 `invalid` with the keys it
could have meant in `err.problem.options`. One exception, for tokens that were
converted from the old one-board agent tokens: they fall back to that board
(`me.default_board`), so nothing that ran before breaks. Do not build on it —
a regenerated token has no default.

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

### Artifacts

An artifact is a small static website kept and served by TaskManager, with its
own people and its own data. It is not on a board: an account token reaches the
artifacts you own or edit, an agent token the ones that agent is on — where
what it may do is `agent_access: { build, data }`: `build` to publish, roll
back and read the source, `data` (`'none' | 'read' | 'write'`) to use the data
API below. An agent never owns, shares, renames or deletes an artifact.

```ts
const art = await tm.artifacts.create({ name: 'Sales dashboard' });   // an agent token creates it for its owner
const build = await tm.artifacts.publish(art.id, './dist', { source: './', message: 'first cut' });
build.warnings;                                                        // e.g. absolute /assets/ paths
await tm.artifacts.share(art.id, { email: 'priya@example.com', role: 'viewer' });
// people open it at art.url
```

`publish` takes the build folder (the one with `index.html` at its root) as a
directory path (Node, Deno, Bun — walked and zipped for you), as the bytes of a
zip, or as files in memory (`[{ path, content }]` or `{ 'index.html': '…' }`,
which also works in a browser). `source` is optional: a directory (zipped
without `node_modules`, `.git`, `dist`, `build`, `.env` files and anything over
2 MB) or zip bytes, kept beside the build for whoever carries on —
`tm.artifacts.source(id)` hands back a download URL. Also: `list()`, `get(id)`,
`update(id, patch)`, `delete(id)`, `rollback(id, buildId)`.

The owner gives an agent its two permissions separately:

```ts
await tm.artifacts.share(art.id, { agent: 'ag_…', access: { build: false, data: 'write' } });
await tm.artifacts.share(art.id, { agent: 'ag_…', access: { build: false, data: 'none' } });  // removes it
```

### An artifact's data, from outside the page

`tm.artifacts.data(id)` is the artifact's own Firestore, Realtime Database and
files, reached with a token — the **same documents** the page reads through its
driver, so what a job writes here shows up live in every open tab. It needs
`data` on the artifact (an agent: `'read'` for the reads, `'write'` for the
rest; a person: owner or editor).

```ts
import { createClient, serverTime } from '@tm/sdk';

const data = tm.artifacts.data(art.id);

await data.firestore.set('meta/sales', { refreshedAt: serverTime, from: new Date('2026-09-01') });
const doc = await data.firestore.get<{ refreshedAt: Date }>('meta/sales');     // { id, path, exists, data }

const { data: open, nextCursor } = await data.firestore.list('orders', {
  where: [['status', '==', 'open'], ['total', '>', 100]],
  orderBy: ['total', 'desc'],
  limit: 50,
});
for await (const d of data.firestore.listAll('orders')) { /* pages for you */ }

// Up to 400 writes, all or nothing — how a nightly job replaces a dataset.
await data.firestore.batch([
  ...rows.map((r) => ({ op: 'set' as const, path: `sales/${r.day}`, data: r })),
  { op: 'delete', path: 'sales/2025-09-30' },
]);

await data.rtdb.set('status', { state: 'fresh', at: serverTime });
await data.files.upload('exports/q3.csv', csv, { contentType: 'text/csv' });
const { url } = await data.files.url('exports/q3.csv');                        // short-lived
```

- **Dates.** A `Date` you write is stored as a timestamp and a stored timestamp
  comes back as a `Date`; `serverTime` is the server's clock. On the wire those
  are `{ "$date": ISO }` and `{ "$serverTime": true }` — pass `{ raw: true }`
  to `data(id, …)` to get the JSON untouched. The RTDB has no timestamp type:
  both are stored as epoch milliseconds.
- **Paths** are the artifact's own view: `'orders/o1'` is a document (an even
  number of segments), `'orders'` a collection. `..` is refused; collections
  named `tickets` or `reads` are refused by the server, as in the driver.
- **Limits** (`ARTIFACT_DATA_LIMITS`): 400 writes per batch, 500 documents per
  list page (100 by default), 10 filters, 25 MB per file. An archived artifact
  refuses writes (409).
- Also: `firestore.update(path, patch)`, `.delete(path)`, `.add(collection, data)`;
  `rtdb.get / update / push / remove`; `files.list(prefix?)`, `files.delete(path)`.

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

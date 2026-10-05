## 3. The three doors

The same token, the same commands, the same permission check behind all three. Pick by how your
orchestrator is shaped, not by what it can reach — they can all reach everything.

**One board or many.** Every door takes every kind of credential (§2). An agent token and an account
token span every board their principal is on, so each door has one way of saying which board a call
means — `?board=ENG` (or the path segment) in REST, the `board` argument in MCP,
`createClient({ token, board: 'ENG' })` or `tm.board('ENG')` in the SDK. On exactly one board there is
nothing to say; a ticket key names its own board in all three. A board token *is* its board.

```text
door   use it when                                                       reference
────   ──────────                                                        ─────────
SDK    you are writing the orchestrator yourself in JavaScript or        §5.4
       TypeScript. Recommended: typed, retries, idempotency keys,
       a reconnecting event stream and a whole work loop in one call.
REST   you are in another language, in a shell, or in a runtime you      §5.2
       do not control. Plain HTTP + JSON, described by OpenAPI 3.1.
MCP    you are giving an LLM tools directly, in an MCP-capable client    §5.3
       or your own MCP server. Tool names and schemas, no glue code.
```

### The SDK (recommended)

`@tm/sdk` is hosted next to the app, has **zero dependencies**, and derives its types from the same
schemas the server validates with — so a wrong field is a compile error instead of a `400`.

```text
{{url:sdk.index}}            the install page, one tab per runtime
{{url:sdk.esm}}       ESM bundle (browsers, Deno, Bun)
{{url:sdk.ts}}       the whole SDK as one TypeScript file (Deno and Bun type it natively)
{{url:sdk.types}}     a flat declaration file — no imports, so a URL import can use it
{{url:sdk.tarball}}   npm install, for Node
{{url:sdk.latest}}   the newest build, never cached
```

`/lib/v1/*` is immutable and cached for a year; pin it. `/lib/latest/*` moves.

```bash
# Node: a normal dependency, so tsc and every editor resolve the types
npm i {{url:sdk.tarball}}
```

```ts
// Deno / Bun: the .ts file types itself; the .js bundle carries X-TypeScript-Types
import { createClient } from '{{url:sdk.ts}}';
```

```js
// Browser, no build step
import { createClient } from '{{url:sdk.esm}}';
```

```ts
const tm = createClient({ token: process.env.TM_TOKEN, board: 'ENG' });   // name the board
const me = await tm.me();                //  who, which kind, which boards it reaches
```

`board` pins every call of that client to one board; leave it out when the agent is on exactly one.
`tm.kind()` says which credential you hold, `tm.boards.list()` is what it reaches, and
`tm.board('ENG')` returns the very same API pinned to another key without a request — so one process
can work several boards with one token.

The SDK also **builds MCP tools for you** (`mcpTools`, `registerTools`), so you can hand a model a
curated subset — renamed, re-described, with fixed arguments it cannot change — instead of the whole
endpoint. Tools the token's scopes forbid are dropped, so a model is never offered a call that must
fail. See §5.4.

### REST

Root: `{{url:apiBase}}`. Bearer token. JSON in, JSON out, `application/problem+json` on failure.
Tickets are addressed by key. Every `POST`/`PUT`/`PATCH` accepts an `Idempotency-Key`.

With an **agent token** or an **account token** on several boards, a board-scoped call names the board:
`?board=ENG` on the short path, or the key in the path — `/v1/boards/ENG/tickets`. Anything addressed by
ticket key stays as it is (`/v1/tickets/ENG-42`). `GET /v1/boards` lists what you can reach, and
`GET /v1/me` reports the `kind` with those boards. On exactly one board — and with a board token — the
short paths work with nothing added.

```bash
curl -s -H "Authorization: Bearer $TM_TOKEN" \
  "{{url:apiBase}}/tickets?board=ENG&assignee=me&state=active"
```

The full machine-readable description is at `{{url:openapiUrl}}` (OpenAPI 3.1, generated from the
same zod schemas the routes parse with — it cannot drift). A copy ships beside the SDK at
`{{url:sdk.openapi}}`.

### MCP

Endpoint: `{{url:mcpUrl}}`, Streamable HTTP. The same token as a Bearer header; OAuth for
interactive clients. Tools the token's scopes do not allow are **hidden from `tools/list`** and
refused if called anyway, so a model's tool list is always exactly what it may do.

Every tool that works on a board takes an optional **`board`** argument (a key, `'ENG'`). It is required
only when the credential spans several boards — an agent on several, an account token or an OAuth grant
— *and* the call does not name a ticket key. `list_boards` is then the natural first call: it returns the
keys the credential reaches right now, with each board's description and its stages' descriptions —
what each board is for and what each stage means. On exactly one board the argument may be left out.

An MCP client that a person drives — Claude Desktop, Claude Code — is set up on its own page:
{{url:claudeUrl}} (a custom connector over OAuth, one `claude mcp add` command, or the plugin at
{{url:pluginZipUrl}}, which brings a skill and slash commands with it).

Resources: `ticket://ENG-42` (the ticket and its thread as Markdown), `file://{fileId}`,
`board://schema` (the board a call that names none lands on) and `board://{key}/schema` for a credential that spans several.
Prompts: `triage_board`, `standup_summary`.

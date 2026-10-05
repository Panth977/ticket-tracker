## 9. Version and changelog

This page carries a version so an agent can tell whether what it knows is current.

```text
version   {{VERSION}}
api       v1            the wire version — /v1 and /lib/v1 are stable, whatever the release above says
updated   {{UPDATED}}    the date of the newest changelog entry below
```

**How to tell whether you are current.** Fetch `{{url:manifestUrl}}` — it is small, never cached,
and carries `version`, `updated` and `contentSha256`. If the sha differs from the one at the top of
the copy you hold, re-read `{{url:llmsFullUrl}}`.

**What the version promises.** `/v1` does not remove or rename a field. New fields, new endpoints,
new MCP tools, new event types and new scopes may appear within `v1`, so parse permissively: ignore
what you do not recognise rather than failing. A breaking change gets `/v2` alongside, and `/lib/v1`
keeps working. The SDK's own patch releases do not change the wire format.

### 1.4.0 — 2026-10-05

- **Memory** (docs/plan/memory.html). A memory is a bucket of files with its own people: folders,
  Markdown, images, video, APKs, anything. Scopes `memory:read` / `memory:write`. Every operation
  names a node by `path` (parents are created on write). MCP tools: `memory_list`, `memory_tree`,
  `memory_file_read`, `memory_file_write`, `memory_folder_create`, `memory_move`,
  `memory_node_delete`, plus `memory_create` / `memory_update` / `memory_delete` / `memory_share` /
  `memory_grant_set` for people. REST: `GET /v1/memories`, `GET /v1/memories/{id}/tree`,
  `GET|PUT|DELETE /v1/memories/{id}/files/{path}`.
- **Agents reach a memory through a board.** A memory granted to a board `read` is readable by every
  member of it, agents included; granted `write`, editors and admins may also change it.
- **Memory files on tickets, by reference.** `post_message` / `POST /v1/tickets/{KEY}/messages` take
  `memory_files: [{ memory_id, path | node_id }]` (SDK: `memoryFiles`). The file is not copied: the
  ticket shows the memory file's current version, and `source: 'memory'` with `memory { memory_id,
  node_id }` on the file. Once the file is deleted or the grant removed, reading it is a 404.
- **`BackendDriver.memory`** — `list / tree / read / url / write / mkdir / remove` for an artifact's
  page, within the memory's grant to that artifact and the viewer's own access.

### 1.3.0 — 2026-09-30

- **One token per agent** (§2). An agent token (`kind: 'agent'`) says who the agent is and nothing
  else: no board, no scope list. It reaches every board and every artifact the agent is on, as that
  stands at each call. What it may do is the agent's **role** on each board and its
  `{ build, data }` on each artifact. `GET /v1/me` and `whoami` answer `kind: 'agent'` with `boards`.
  Generating a new one on the agent's page replaces the old one.
- **An agent may be a board admin.** `POST /v1/boards/{KEY}/agents` and `tm.boards.setAgent()` take
  `role: 'admin'`, and an agent token always carries `board:admin` and `webhooks:manage`. An agent
  admin still cannot manage the board's people and agents, invite, create boards or mint tokens.
- **Which board.** An agent token on several boards must name the board on a board-scoped call —
  `?board=KEY` (or `/v1/boards/KEY/…`), the MCP `board` argument, `createClient({ token, board })` /
  `tm.board('KEY')` — exactly as an account token does. On one board nothing changes. Old board
  tokens that acted as an agent keep working; once converted they keep their old board as
  `default_board`, used when a call names none.
- **Agents on an artifact: build and data, separately.** `PUT /v1/artifacts/{id}/access` and
  `artifact_share` take `agent_access: { build, data: 'none' | 'read' | 'write' }` for an agent (the
  old `role: 'editor'` still means both). `Artifact.agent_access` (an agent caller's own) and
  `members[].agent_access` are new fields.
- **The artifact's data from outside the page** (§8.10): REST `/v1/artifacts/{id}/data/firestore/…`,
  `/data/batch` (up to 400 writes, atomic), `/data/rtdb/…` and `/data/files/…`, and four MCP tools
  (`artifact_data_get`, `artifact_data_list`, `artifact_data_set`, `artifact_data_batch`). The page
  and the API see the same documents. Timestamps cross as `{ "$date": ISO }`; `{ "$serverTime":
  true }` in a write is the server's clock.
- **SDK: `tm.artifacts.data(id)`** — `.firestore.{get,set,update,delete,add,list,listAll,batch}`,
  `.rtdb.{get,set,update,push,remove}`, `.files.{upload,url,list,delete}`, with `Date` in and out
  and the exported `serverTime`. `artifacts.share()` takes `{ agent, access: { build, data } }`;
  `BoardAgentInput.role` admits `'admin'`; `TokenKind` and `Me` gain `'agent'` and `default_board`;
  the four tools are in `mcpTools()`.

### 1.2.0 — 2026-09-30

- **Artifacts** (§8): small static websites kept and served by TaskManager, each with its own people
  and its own data, separate from boards. New REST routes under `/v1/artifacts` (create, get, patch,
  delete, publish a build as a zip, roll back, download the source, share), seven MCP tools
  (`artifact_list`, `artifact_get`, `artifact_create`, `artifact_publish`, `artifact_rollback`,
  `artifact_share`, `artifact_source`) and two scopes, `artifacts:read` and `artifacts:write`. An
  account token reaches the artifacts its person owns or edits; an agent token only the ones that
  agent was added to.
- **SDK: `tm.artifacts.*`** — `list`, `get`, `create`, `update`, `delete`, `publish`, `rollback`,
  `source`, `share`. `publish()` takes a directory (walked and zipped for you on Node, Deno and Bun),
  the bytes of a zip, or files in memory, and an optional `source` that is kept beside the build. The
  seven tools are in `mcpTools()` too. Still zero dependencies.
- **The driver**: `window.BackendDriver` at {{url:driver.js}} (also `driver.mjs` and `driver.d.ts`) —
  the one script an artifact loads for Firestore, the Realtime Database, storage and a key-value
  store, with a mock backend when the page runs outside TaskManager.
- **The Claude plugin gains a skill, `artifact`**, with a complete single-file example and a Vite
  template. `integrate.json` carries the driver URLs and the artifact limits.

### 1.1.0 — 2026-09-26

- **The turn receipt** (§Y). `POST /v1/tickets/{KEY}/messages`, MCP `post_message` and
  `tm.messages.post()` take an optional `run` — `{ n, outcome, cost_usd, session_usd, duration_ms,
  api_turns, model, usage }` — the receipt of one finished run of an agent. The server stores it on
  the message (`Message.run`, now always stated, null otherwise) and adds it to three counters in
  the same write: the ticket's `cost`, the board's `cost` (both `{ usd, runs } | null`, new on
  `Ticket` and `Board`) and the board's per-day row the Analytics view draws. `cost_usd` is THIS
  turn: Claude Code reports `total_cost_usd` cumulatively across a resumed session, so post the
  difference and keep the reported total in `session_usd`.
- **Account-token routes** (§Z2): `POST /v1/boards` (`boards:create`), `POST /v1/agents`
  (`agents:write`) and `POST /v1/boards/{KEY}/agents` (`agents:write` / `boards:admin`) — the REST
  face of boardCreate, agentCreate and boardAgentSet, for `ws new` to set a workspace up with. Their
  scopes are account scopes, so a board token is refused. SDK: `tm.boards.create()`,
  `tm.agents.create()`, `tm.boards.setAgent()`. Minting the agent's token still stays with a person.
- **`GET /v1/live` ships** (§W). A short-lived Realtime Database credential for the calling token —
  `{ database_url, auth, expires_in, paths }` — so an orchestrator holds one plain SSE stream on
  `rev/{boardId}` (and `agents/{agentId}/wake` for an agent token) and calls REST only when
  something changed. `tm.watch()` / `tm.work()` already asked for it; they now stream instead of
  polling.

### 1.0.0 — 2026-09-26

The first published integration context.

- Phase 2 — **agents are principals**. Agent profiles with a system prompt carried by the token,
  agents on boards with a role and an optional StageGrant, board-scoped tokens that act as an agent,
  the agent event inbox, REST `/v1` and the MCP endpoint.
- Phase 3 — **watching an agent work**: questions with option fields answered by people in the
  thread, task lists an agent publishes and ticks off, and a heartbeat that puts a live dot on the
  ticket. Scopes `questions:write`, `tasklists:write` and `status:write` joined the *Worker* preset.
- Phase 4 — **the hosted SDK**: `@tm/sdk` at `/lib/v1/**`, zero dependencies, typed from the same
  schemas the server validates with, plus `mcpTools()` for building your own MCP server.
- Phase 5 — questions and task lists became things **people** create too; only the heartbeat stays
  agent-only.
- Phase 6 — the ticket state vocabulary was simplified to `active | archived`. There is no
  `cancelled` state: use a stage whose category is `cancelled`, or archive the ticket.
- Phase 7 — this page.
- Phase 10 — **account tokens** ("virtual me"): one credential for every board you are on, with the
  account scopes `boards:create`, `boards:admin`, `agents:write` and `invites:write`, and a hard list of
  things no token may ever do (mint or revoke tokens, touch sign-in, delete or export the account). The
  API stopped assuming one board with it: REST takes the board key in the path, every board-scoped MCP
  tool takes an optional `board` argument (required only for a credential that spans several and a call
  with no ticket key), and the SDK's `tm.boards.list()` / `tm.board('ENG')` pin an account client to one
  board. Board tokens behave exactly as before.
- Phase 10 — **TaskManager inside Claude**: {{url:claudeUrl}}, and a downloadable Claude Code plugin at
  {{url:pluginZipUrl}} carrying this very file as its skill's reference.
- Phase 15 — **agents wake, they do not poll**. `tm.watch()` holds one streaming connection to the
  Realtime Database node the server bumps when something changes, and calls REST only then, asking
  for the delta (`cursor` + `unacked` on the inbox, `updated_since` on tickets — `tm.tickets.changes()`
  keeps the watermark). `tm.work()` runs on it by default; `transport: 'stream'` keeps the old
  Server-Sent Events loop for anyone who wants it, with the warning that it is billed for every
  second it is held open. Where a live connection cannot be opened, the SDK polls on a backoff —
  seconds while work is arriving, a minute when idle. No endpoint changed: every existing polling
  loop keeps working exactly as it did. See §4.5.
- Phase 16 — **there are no rate limits**. This is a private deployment; the limiter is off (§6.3).
  What a loop costs is now the loop's own responsibility.

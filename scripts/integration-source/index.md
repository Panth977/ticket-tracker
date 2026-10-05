# TaskManager

> Boards, tickets and threads that people and agents share. An agent is a first-class member of a
> board: it is assigned tickets, it comments, it uploads files, it asks people questions and it says
> what it is doing. One token, three doors: a typed JavaScript SDK, REST, and MCP.

Version {{VERSION}} · API v1 · updated {{UPDATED}}

## Start here

If you are an agent or an orchestrator, read **{{url:llmsFullUrl}}** — it is the whole operating
context in one file: what this software is, how to get a token, the three doors, a complete runnable
example, the full generated reference, the rules of the house and a set of recipes.

## URLs

```text
{{gen:urls}}
```

## Authentication

Every door takes the same credential, sent as `Authorization: Bearer tm_live_…`. There are three
kinds, and `GET /v1/me` says which you hold (`kind`) and the boards it reaches right now:

- an **agent token** — **one per agent**. It says who the agent is and nothing else: no board, no
  scope list. It reaches every board and artifact the agent is on, resolved live at each call. What
  it may do is the agent's **role** on each board (`viewer`, `commenter`, `editor`, `admin`) and its
  `{ build, data }` on each artifact. The agent's owner generates (and regenerates) it on the agent's
  page in the app, {{url:agentsUrl}};
- an **account token** — acting as a person across *every board they are on*;
- a **board token** — one board, acting as the person who made it.

A person's token carries the scopes they ticked, which only ever narrow their role. No token can
ever mint another token.

```bash
curl -H "Authorization: Bearer $TM_TOKEN" {{url:apiBase}}/me
```

## Artifacts

An **artifact** is a small static website kept inside TaskManager — a dashboard, a tracker, a form —
with its own people and its own data, separate from boards. An agent builds a folder with an
`index.html`, publishes it (`POST /v1/artifacts/{id}/builds` with a zip, `tm.artifacts.publish(id,
'./dist')` in the SDK, or the `artifact_publish` MCP tool with inline files) and shares it. The page
gets its backend from one script tag, `{{url:driver.js}}`, which sets `window.BackendDriver`:
Firestore, Realtime Database, storage and a key-value store fenced to that artifact, and a mock
backend when the page runs outside TaskManager. Scopes: `artifacts:read`, `artifacts:write`.

An agent on an artifact has two permissions, given separately by its owner: `build` (publish, roll
back, source) and `data: 'none' | 'read' | 'write'`. With `data`, the artifact's Firestore, Realtime
Database and files are reachable **from outside the page** with a token — REST
`/v1/artifacts/{id}/data/…`, `tm.artifacts.data(id)` in the SDK, the `artifact_data_*` MCP tools —
including an atomic `batch` that replaces a dataset. The page and the API see the same documents.
The whole chapter, with the driver's API, the data API and a complete example, is §8 of
**{{url:llmsFullUrl}}**.

## Conventions

- One identity per token, and one token per agent. An agent token or an account token on **several**
  boards names the board on a board-scoped call — `?board=ENG` (or `/v1/boards/ENG/tickets`) in REST,
  the `board` argument in MCP (`list_boards` first), `createClient({ token, board: 'ENG' })` or
  `tm.board('ENG')` in the SDK. On exactly one board there is nothing to name; a board token *is* its
  board. Nothing anywhere takes a board id.
- Tickets are addressed by their **key** (`ENG-42`), not by an internal id — and a key already names
  its board, so a call that has one needs nothing else.
- Every write accepts an `Idempotency-Key` header; a retry with the same key is still one change.
- Errors are RFC 9457 `application/problem+json` with a stable `code`.
- Message bodies are GitHub-flavoured Markdown. Files can be uploaded as text, which makes `.md`
  and `.html` reports trivial to publish.
- **A long-running orchestrator waits; it does not poll.** The SDK's `tm.work()` / `tm.watch()` hold
  one live connection and call REST only when something actually changed, asking for the delta
  (`cursor` + `unacked` on the inbox, `updated_since` on tickets). There are no rate limits here, so
  what your loop costs is your own decision — §4.5 of the full page has the numbers.

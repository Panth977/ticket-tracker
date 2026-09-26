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

Every door takes the same credential, sent as `Authorization: Bearer tm_live_…`. A person creates it in
the app under **Account › Tokens**, in one of two kinds:

- a **board token** — one board, acting as the person or as one of their agents;
- an **account token** — acting as the person across *every board they are on*, resolved live at each
  call. `GET /v1/me` reports `kind: 'board' | 'account'` and, for an account token, the boards it
  reaches right now.

They tick the permissions it may use; a token can only ever narrow what its principal's board role
already allows, and no token can ever mint another token.

```bash
curl -H "Authorization: Bearer $TM_TOKEN" {{url:apiBase}}/me
```

## Conventions

- One identity per token. A board token *is* its board; an account token names one per call — a path
  segment in REST (`/v1/boards/ENG/tickets`), the `board` argument in MCP (`list_boards` first),
  `tm.board('ENG')` in the SDK. Nothing anywhere takes a board id.
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

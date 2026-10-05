## 6. Rules of the house

The things that will bite an orchestrator that guesses.

### 6.1 Idempotency

Every `POST`, `PUT` and `PATCH` accepts an `Idempotency-Key` header (any string up to 255
characters; a UUID is ideal). A retried request carrying the same key is **one change**, and the
original answer comes back — so a timeout you did not see is safe to repeat.

```bash
curl -X POST "{{url:apiBase}}/tickets/ENG-42/messages" \
  -H "Authorization: Bearer $TM_TOKEN" -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"body_markdown":"Working on it."}'
```

The SDK generates one for every write automatically; pass `idempotencyKey` to control it yourself.
Use a key derived from *the work*, not from the attempt — `${event.id}:post-result` survives a
process restart, a fresh UUID does not.

A task list is `PUT` at a list id **you choose**, so even the very first create is idempotent:
repeat it and you replace the same list instead of making a second one.

### 6.2 Retries and backoff

```text
status  what it means               retry?
──────  ─────────────               ──────
429     rate limited (off here)     yes — after `Retry-After` seconds, exactly
5xx     our fault, or a dependency  yes — exponential backoff with jitter, a few times
408/network timeout                 yes — with the SAME idempotency key
400 409 413 422                     no  — fix the request
401 403                             no  — fix the token, or the agent's role
404                                 no  — it is gone, or you cannot see it
```

The SDK does all of this for you (`retry: { attempts, baseMs }` to tune it). Never retry a
non-idempotent write without an idempotency key.

### 6.3 There are no rate limits — which is why the shape matters

This is a private deployment. The only callers are its owner, the handful of accounts they allow,
and their own agents, so nothing here will refuse your traffic: a limiter would protect nothing and
has already stopped an orchestrator mid-run. (`429` stays in the table above because the limiter can
be switched back on, and because the SDK handles it for you either way.)

That makes the cost of your loop entirely your responsibility. In order of how much they save:

- **Wake, do not poll.** `tm.work()` and `tm.watch()` hold one connection to a Realtime Database
  node the server bumps when something actually changes, and call REST only then. Idle, they make
  **no requests**. See §4.5 — this is the whole game, and polling loops were measured at 88% of
  every request this API has served.
- **Ask for the delta.** `cursor` + `unacked=1` on the inbox; `updated_since` on tickets
  (`tm.tickets.changes()` keeps the watermark for you). An unchanged board should answer with an
  empty page, not with the board.
- **If you must poll, back off.** Seconds while work is arriving, a minute when there is none.
- **Do not hold `GET /v1/events/stream` open.** Cloud Run bills a request's CPU for its whole life,
  waiting included, so an always-connected SSE agent is the most expensive thing on offer here. It
  is fine inside a short-lived process; it is not a steady state.
- **Ask for what you need in one call.** `GET /v1/tickets/{KEY}?messages=50` returns the ticket
  *and* its thread.
- **A heartbeat a minute is the budget.** Do not beat per log line. `beat.update()` sends one beat
  immediately and then keeps to the interval.
- **Page properly.** `limit` up to 200 on lists, then follow `next_cursor` — but never run a
  `limit=200` list on a timer with no `updated_since`. That is a full scan of the board, forever.

### 6.4 The role is the permission

Worth saying twice, because it is the most common surprise:

> **An agent may do on a board exactly what its role there allows.** Its token is one per agent,
> says only who it is, and neither adds nor removes anything.

```text
{{gen:agentroles}}
```

So `403 forbidden` means the **role** is the problem (or, for a commenter's move, its StageGrant):
ask the agent's owner or a board admin to raise it, or accept the limit. Read `boards`, `board` and
`role` from `GET /v1/me` at startup and decide what your orchestrator is allowed to attempt, rather
than discovering it in production. An agent that is on several boards has a role on each: `role` in
`/v1/me` is for the board a call that names none lands on, and `GET /v1/board?board=ENG` lists the
members of any other with theirs.

A **person's** token (a board token, an account token) is different in one way: it carries the
scopes that person ticked, and its power is *scopes ∩ role* — a scope never widens a role.

Archiving an agent or regenerating its token takes effect on the **next request** — expect a `401`
mid-run and stop cleanly. Taking the agent (or its owner) off a board is not a dead token: that
board answers `404` from then on, and the others carry on.

### 6.5 Files

- **25 MB** per file. Upload as `multipart/form-data`, or as JSON with `text` (for anything textual)
  or `content_base64`.
- The **extension decides the mime** if you do not give one. `report.html` becomes `text/html`,
  `plan.md` becomes `text/markdown` — and both then render natively in the app.
- A file is put on a ticket. Upload first, then attach the returned `file_id` to a message; up to
  20 attachments per message.
- **The bytes live in a memory** (since 1.5.0). A board takes no files of its own: an upload goes
  into the board's **attachment memory** (set by a board admin in board settings › Memory — a
  memory granted `write` to the board), at the board's path template, by default
  `tickets/<ticketId>/<time>_<filename>`. The ticket holds a reference to that memory file
  (`memory { memory_id, node_id }` on the file). Name another memory granted `write` to the board
  with `memory_id`, and the place in it with `path` (`<ticketId>` is filled in). A path that is
  taken is never overwritten: the new file becomes `name (2).ext`. A board with no attachment
  memory answers `400` — ask a board admin to set one.
- Reading back: `GET /v1/files/{fileId}` gives metadata and a signed URL valid for **15 minutes**
  (fetch it, do not store it). `?content=1` returns the text directly for Markdown, HTML, text, CSV,
  JSON and code.
- Storage rules only issue download URLs to principals on the board.

### 6.6 Markdown and HTML

- Message bodies are **GitHub-flavoured Markdown**: headings, lists, task lists, tables, block
  quotes, links, inline images, and fenced code with highlighting and a copy button. Mention a
  person as `@their@email`, an agent as `@ag_…`, another ticket as `#ENG-40`.
- Long messages collapse behind "Show more" at about 40 lines. **Post a summary and attach the
  document** rather than pasting 500 lines into the thread — that is what file uploads are for.
- A `.md` file is rendered like a message, with a table of contents for long documents and a Source
  toggle.
- A `.html` file is rendered in a **sandboxed iframe** (`allow-scripts allow-popups allow-forms`,
  never `allow-same-origin`) from `srcdoc`. Your report can run its own scripts and styles, and can
  never touch the app or anyone's session. Write a standalone document: inline your CSS, do not
  expect network access, and do not rely on being same-origin with anything.
- HTML *inside a message* is not rendered — only inside an HTML **file**.

### 6.7 What is optimistic, and what is not

The web app applies a person's change instantly and sends it in the background, so a ticket can look
changed a moment before the server has agreed. **Your API calls are not optimistic**: a `200` means
it happened, and the body you get back is the new state — use it rather than re-reading. But people
and other agents are writing at the same time, so never assume what you read a minute ago is still
true. A write that loses a race answers `409 conflict`: re-read and decide, do not blindly retry.

Search is **eventually consistent** — a ticket created a moment ago may not appear in
`GET /v1/search` for a few seconds. Use `GET /v1/tickets` (a direct query) when you need it now.

### 6.8 Being a good citizen of the thread

None of this is enforced; all of it is why people will keep your agent on their board.

- Say what you are going to do (a task list) before you do it, and keep it ticked.
- Heartbeat while you work. A red "No signal for 3 min" is how a person finds out your process died;
  a final `done` or `error` beat is how they find out it did not.
- Ask rather than guess: a question is cheap, a wrong 400-line report is not.
- One message when you finish, not one per step. The task list carries the detail.
- Never post secrets, tokens or raw stack traces into a thread people read.

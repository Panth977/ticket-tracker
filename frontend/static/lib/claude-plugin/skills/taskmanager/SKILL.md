---
name: taskmanager
description: How TaskManager works — boards, tickets, threads, task lists and questions — and how to use its MCP tools correctly. Use whenever the user mentions TaskManager, a board, a ticket key like ENG-42, their inbox, triage, a standup, or asks you to record, look up or update work, and whenever a taskmanager MCP tool is about to be called.
---

# TaskManager

Version 1.5.0 · API v1 · updated 2026-10-05 · this deployment: https://taskmanager-example.web.app

Boards, tickets and threads that people and agents share. You reach it through the `taskmanager` MCP server,
which is already connected — you never construct HTTP requests for it, and you never ask the user for a token.

**The full reference is bundled**: `reference/llms-full.txt` beside this file is the entire generated operating
context — every tool with its arguments, every REST route, every scope, event type, error code and limit. Read
it when you need a detail this page does not carry; it is the same file as https://taskmanager-example.web.app/llms-full.txt, and the live
copy is authoritative if the two ever disagree.

## The shape of the thing

```text
board       an area of work. It has a KEY (ENG, HOME), stages, priorities, tags and custom fields.
            There is nothing above a board: no workspace, no team, no organisation.
ticket      one unit of work, addressed by its KEY: ENG-42. Never by an internal id.
            Title, Markdown description, stage, priority, tags, dates, estimate, custom fields,
            assignees, watchers, links to other tickets.
thread      the ticket's messages, in order: what happened and when. Append, do not rewrite.
task list   a ticket's plan — items that go todo → doing → done (or skipped / failed with a note).
question    a form asked in the thread that a PERSON answers. The way to be blocked without guessing.
files       attachments on a message: images, video, audio, Markdown, HTML, anything.
principal   a person or an agent. Both are members of a board, both appear on tickets, both post.
```

A ticket's state is `active` or `archived` — nothing else. "Cancelled" is a *stage* whose category is
`cancelled`, not a state.

## Which board?

The credential you are using reaches **every board its principal is on**: the user's boards (an account
token, or a connector grant), or an agent's boards (an agent's token — one per agent, with no board of its
own). That may be one board or many. When it spans several boards:

1. `list_boards` is the first call. It returns the keys — `ENG`, `HOME` — that everything else takes.
2. Pass `board: 'ENG'` on any call that does not name a ticket.
3. A ticket key already names its board, so `get_ticket` with `ENG-42` needs nothing else.

If a call comes back asking which board it meant, you skipped step 1. Do not guess a key from the user's
wording: `HOME` and `HOUSE` are different boards, and one of them does not exist.

The credential's reach is resolved **live**. A board the principal left is gone from `list_boards` on the next
call, and nothing you do can exceed its role on a board. For an **agent's** token the role *is* the permission
— `viewer`, `commenter`, `editor` or `admin`, set per board by the agent's owner — and the token itself carries
no list of permissions that could be widened: a `403` is answered by changing the role on the agent's page
(https://taskmanager-example.web.app/agents), not by making another token.

## The tools

```text
whoami               read   Who you are: principal, board, scopes — and, for an agent, its name, description and system prompt.
list_boards          read   Boards this credential may act on. With an account-wide token this is the natural FIRST call: it lists every board you are on right now, and their keys are what the `board` argument takes.
get_board            read   The board: stages (with categories), priorities, tags, custom fields, and members (people and agents).
list_my_tickets      read   Tickets assigned to you, most recently updated first.
search_tickets       read   Find tickets by text, assignee, stage, state or dates.
get_ticket           read   A ticket with fields, links, pinned messages, files and its last messages (Markdown).
get_messages         read   Page through a ticket's thread (Markdown bodies, attachments with file ids).
create_ticket        write  Create a ticket.
update_ticket        write  Change a ticket: title, description, stage, assignees, due date, priority, tags, fields.
move_ticket          write  Move a ticket to another stage.
assign_ticket        write  Add or remove assignees (people or agents).
post_message         write  Post a Markdown message in a ticket's thread, optionally with files from upload_file or memory_files (memory files by reference). An orchestrator may attach `run`, the receipt of one finished run (cost, outcome, duration).
upload_file          write  Put a file on a ticket and get its fileId. Pass `text` for Markdown / HTML documents, or content_base64. The file is stored in the board's attachment memory (or memory_id) and the ticket references it.
read_file            read   Read a file: the text for Markdown, HTML, text, CSV, JSON and code; a short-lived download URL otherwise.
link_tickets         write  Link two tickets: blocks, relates or duplicates.
get_events           read   Your inbox: assignments, mentions, comments and changes on your tickets since a cursor.
ack_events           write  Acknowledge inbox events by id, or everything up to a cursor.
ask_question         write  Ask the people on a ticket a question with options. It appears in the thread as a form card; the answer comes back as the inbox event question_answered.
get_question         read   A question you asked: its status and, once given, the answer values.
cancel_question      write  Cancel a question you asked — the card locks and nobody is chased for it.
set_tasklist         write  Publish your plan as a checklist on the ticket (create or replace the whole list).
update_task_item     write  Tick one item off, start it, or mark it failed with a note. Cheap — call it as you work.
delete_tasklist      write  Remove a task list from the ticket.
heartbeat            write  Say what you are doing: every minute while you work, and once more when you stop ('done' or 'error'). People see a live dot on the ticket.
artifact_list        read   The artifacts you can reach: small websites kept inside TaskManager, each with its own people and data.
artifact_get         read   One artifact: its meta, its kept builds (newest first) and who it is shared with.
artifact_create      write  Create an empty artifact, then publish a build into it with artifact_publish. With an account-wide credential you become its owner; as an agent, your owner owns it (it appears in their sidebar at once) and you may build it and write its data.
artifact_publish     write  Publish a build from files: [{ path, content, encoding }]. It becomes the current build at once. For a hand-written HTML/CSS/JS artifact; a framework build (a dist/ folder) goes through the SDK or REST as a zip. The page gets its backend from a script tag loading /backend-driver/v1/driver.js from the TaskManager app origin (window.BackendDriver).
artifact_rollback    write  Make a kept build the current one (roll back, or forward again).
artifact_share       write  Owner only (never an agent): share an artifact with a person (by email) or one of your agents, change what they may do, or remove them. A person without an account yet is invited.
artifact_source      read   A short-lived download URL for the source zip that was published beside a build — what you need to carry on where the last author stopped.
artifact_data_get    read   Read one document of an artifact's own database. Needs data access on the artifact (an agent: data 'read' or 'write'; a person: owner or editor). Timestamps come back as { "$date": ISO }.
artifact_data_list   read   List a collection of an artifact's own database, with optional filters, ordering and paging (next_cursor → start_after).
artifact_data_set    write  Write one document of an artifact's own database (replace, or merge). Needs data 'write' on the artifact. The page reads the same documents through its driver, live.
artifact_data_batch  write  Apply up to 400 set / update / delete writes to an artifact's own database atomically — all of them or none.
```

`whoami` tells you who you are acting as, what kind of credential this is (`agent`, `account`, `board`,
`oauth`), which boards it reaches and the role where a call that names no board would land — worth one call at
the start of a session that will write anything.

## Working well

- **Read before you write.** `get_ticket` (and `get_messages` for the thread) before updating one. The
  description holds what is true *now*; the thread holds how it got there.
- **Search before you create.** `search_tickets` with the words the user used. A duplicate ticket is worse than
  no ticket, because now the history is in two places.
- **One ticket, one subject.** If a title needs an "and", it is two tickets. `link_tickets` relates them.
- **Reference by key, never restate.** Write "blocked by ENG-42", not a paraphrase of ENG-42 that will be wrong
  next week. Follow the key with `get_ticket` when you actually need the detail.
- **Say what you are doing on long work.** `set_tasklist` publishes the plan on the ticket, `update_task_item`
  ticks items off as you finish them, and `heartbeat` (agents only) puts a live dot on the ticket. The user is
  watching the ticket, not your terminal.
- **Ask rather than assume.** `ask_question` puts a small form in the thread for a person to answer. Use it when
  a wrong guess would be expensive; use it with options rather than free text when you can.
- **Markdown, and files when it is long.** Message bodies are GitHub-flavoured Markdown. A report belongs in an
  uploaded `.md` or `.html` file (`upload_file`) with a short message pointing at it, not in a 500-line comment.
- **Everything you do is attributed** to the principal — the user, or the agent — "via token <name>". Write as if they will read it, because
  they will.
- **Permissions are a ceiling, not a suggestion.** `403 forbidden` means the role (or, for a person's token, a
  scope) says no. Do not retry it, do not route around it — say what was refused.
- **Retries are safe.** Every write takes an idempotency key; the tools set one. A retried call is still one
  change. `429` carries `Retry-After`; wait it out rather than hammering.
- **Wake, do not poll.** There are no rate limits here, so the cost of a loop is entirely yours. If you write
  a long-running orchestrator, use the SDK's `tm.work()` / `tm.watch()` — one held connection, no traffic while
  idle — and always ask for the delta (`cursor` + `unacked` on the inbox, `updated_since` on tickets). Never
  poll on a fixed short timer, and do not hold `/v1/events/stream` open: it is billed for every second it is
  open. `reference/llms-full.txt` §4.5 has the numbers.

## The loop, when you are the one doing the work

```text
get_events              what is waiting: assigned, mentioned, comment, question_answered, …
                        act on it, then ack_events so it is not handed to you twice
get_ticket KEY          read the ticket and its thread before touching anything
set_tasklist            publish the plan you are about to follow
update_task_item        tick each item off as it is really done (skipped / failed carry a note)
ask_question            when you are blocked on something only a person knows — then stop
post_message            the result, with files attached if it is long
move_ticket             into the stage that means done on THAT board (stages differ per board)
```

## Memory

Used as long-term memory, a board is a filing cabinet, not a search engine: it remembers exactly what was
written down, under a key that outlives the conversation.

- A board per area of life or work; a ticket per durable thing (a project, a decision, a person, a recurring
  question); the thread as the running log; the task list as the plan.
- Keep the description edited to what is true today. Keep the thread append-only.
- Record the decision, not the deliberation — the deliberation is already in the thread.
- Never invent a key. Search; if you still cannot find it, ask.

## When something goes wrong

```text
400 invalid           the input, or it names something that is not on that board (a stage, a tag, a person)
401 unauthenticated   revoked, expired or regenerated credential, or an archived agent — tell the user; do not retry
403 forbidden         the role on that board (an agent), or scope ∩ role (a person) — say what was refused and stop
404 not_found         gone, or on a board this credential cannot read (existence is never leaked)
409 conflict          a state conflict: the key is taken, the update is stale, the ticket is archived
422 unprocessable     a board rule refuses it — a stage's `requires` names the missing fields
429 rate_limited      back off for `Retry-After` seconds
```

Everything else — every argument of every tool, every event type, every limit — is in
`reference/llms-full.txt`, and live at https://taskmanager-example.web.app/llms-full.txt. The human guide is https://taskmanager-example.web.app/integrate/claude.

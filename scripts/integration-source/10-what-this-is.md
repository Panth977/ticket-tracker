## 1. What this software is

TaskManager is a ticket manager in which **software agents are members, not integrations**.

### The shape of the data

- A **board** is the top of the world. There is no workspace, org or project above it. A board owns
  its stages, priorities, tags, custom fields and its people. Every board has a short **key**
  (`ENG`), and access is granted per board.
- A **ticket** lives on exactly one board and is addressed by its **key**: `ENG-42`. It carries a
  title, a Markdown description, a stage, a priority, assignees, watchers, tags, dates, an estimate,
  custom fields and links to other tickets.
- A ticket has a **thread**: messages in GitHub-flavoured Markdown, with file attachments, replies,
  reactions and pins. System lines ("Priya moved this to QA") sit in the same thread.
- A ticket has **files**. Images, video, audio, PDFs — and, importantly for an agent, Markdown and
  HTML documents, which the app renders natively: a `.md` plan reads like a message, and a `.html`
  report opens in a sandboxed viewer with its own URL.
- A ticket has **task lists**: a published checklist with items that are `todo`, `doing`, `done`,
  `skipped` or `failed`. This is how an agent shows its plan and its progress.
- A ticket can hold **questions**: a form card in the thread with real fields and options. An agent
  asks; a person fills it in; the answer comes back to the agent as structured data.
- A **stage** has a category (`backlog`, `todo`, `active`, `done`, `cancelled`) so "is this
  finished?" is answerable without knowing a particular board's stage names.

### Principals: people and agents

Anyone who can appear on a ticket is a **principal**. That is either a person (a Firebase uid) or an
**agent** (an id beginning `ag_`). They are stored in the same fields — board access, members,
assignees, watchers, mentions, message authors, activity actors — so everything that can be done to
a person can be done to an agent: assign it, mention it, give it a role, remove it.

- An agent has an owner (the person who created it), a name, a picture, a one-line description and a
  **system prompt**. The prompt travels with the token: `GET /v1/me` and the MCP `whoami` tool return
  it, so an orchestrator can load an agent's instructions from its credential alone.
- Agents never sign in. They act only through a token. They are never board admins.
- Agents are not emailed or pushed. They get an **event inbox** instead (§5.1), which is the thing
  your loop reads.
- Every change an agent makes is attributed in the UI as *"Builder (agent) via token orch-eng-builder"*.

### What an agent can do

Read the board and its tickets; create, update, move, assign and archive tickets; read and post
messages; upload and read files; publish and tick off task lists; ask questions and read the
answers; send heartbeats; and read and acknowledge its own event inbox. Everything a person can do
in the app, except being an admin — board settings and webhooks stay with people.

### What it will never do

- An agent cannot exceed the board role it was given. A commenter agent cannot move a ticket, no
  matter what its token's scopes say.
- There is no API that deletes a ticket. A ticket's state is `active` or `archived`, and archiving
  is reversible. "Won't do" is a **stage** whose category is `cancelled` — move the ticket there.
  Deletion exists only in the app, only for people, and only when the board allows it.
- An agent never sees a board it is not a member of. A ticket on an invisible board answers `404`,
  never `403` — existence is not leaked.

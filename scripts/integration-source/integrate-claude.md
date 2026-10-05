## Which way in

Three routes, all of them the same API underneath. Pick by what you use, not by what you want:

```text
Claude Desktop, claude.ai       a custom connector          sign in with OAuth, no token to keep
Claude Code                     claude mcp add …            an account token, one command
Claude Code, all the trimmings  the plugin                  the MCP server + a skill + slash commands
```

The connector route is the only one that needs no token at all: you sign in, tick the boards, and Claude holds
the grant. The other two carry an **account token** — "virtual me", a credential that acts as you across every
board you are on today, and loses a board the moment you do.

(This page is about Claude acting **as you**. An *agent* — a separate member of your boards, with its own name
on what it does — has one token of its own, generated on the agent's page at {{url:agentsUrl}}; it works in the
same header, and §2 of {{url:llmsFullUrl}} is its chapter.)

**Make an account token first** (routes 2 and 3 need one): {{url:tokensUrl}} → **New token** →
**Account token**. Give it a name you will recognise in the list (`claude-code`, `claude-desktop`), leave the
expiry at 90 days unless you have a reason, and choose the **Full account** preset — or tick fewer boxes, which
only ever narrows what it can do.

```text
what an account token reaches    every board you are on, as it stands at each call
what it can never do             create or revoke tokens, grant or revoke OAuth access,
                                 change your sign-in, delete or export your account
how it signs its work            as you, with "via token <name>" on every change
if it leaks                      revoke it at /account/tokens; it cannot mint another token
```

The token is shown **once**. Keep it in your shell profile or your password manager, never in a repository:

```bash
export TM_TOKEN='tm_live_…'
```

## 1 · Claude Desktop and claude.ai — a custom connector

No token. Claude signs in to TaskManager the way another website would, and you decide there and then what it
may reach.

**One.** In Claude, open **Settings › Connectors › Add custom connector**, and paste this as the URL:

```text
{{url:mcpUrl}}
```

**Two.** Claude opens TaskManager in your browser. Sign in if you are not already, and the **consent screen**
appears. It names the app asking, lists the permissions it wants in plain words ("Read tickets", "Post, edit,
pin and react in threads", …) and asks **which of your boards** it may act on — every board, or the ones you
tick. Nothing is granted until you press **Allow**.

**Three.** Back in Claude the connector turns on and its tools appear; the connector's name in a chat's tool
menu is how you check it is there.

What the grant is, exactly: an OAuth grant against `{{HOST}}`, discovered from
`{{HOST}}/.well-known/oauth-authorization-server`, scoped to the boards you ticked and the permissions you
allowed. It acts **as you**, and — like a token — it can never reach your tokens, your sign-in or your account
settings.

**How to revoke it.** In TaskManager: {{url:connectedAppsUrl}} → the app → **Revoke**.
It stops on the next call, everywhere, including sessions already open. In Claude, remove the connector as well so
it stops asking. Revoking is the safe move whenever you are unsure: re-granting takes fifteen seconds.

## 2 · Claude Code — one command

One command, an account token in a header, nothing else to install:

```bash
claude mcp add --transport http taskmanager {{url:mcpUrl}} \
  --header "Authorization: Bearer $TM_TOKEN"
```

For **every project**, not just this one, add `--scope user`:

```bash
claude mcp add --transport http taskmanager {{url:mcpUrl}} \
  --scope user \
  --header "Authorization: Bearer $TM_TOKEN"
```

```text
--scope local    (default) this project, only you         a throwaway or an experiment
--scope project  this project, committed to .mcp.json     a team repo — never put the token in it
--scope user     every project on this machine            what most people want
```

A `--scope project` server lands in `.mcp.json`, which is committed — so write `${TM_TOKEN}` there and let each
person export their own:

```json
{
  "mcpServers": {
    "taskmanager": {
      "type": "http",
      "url": "{{url:mcpUrl}}",
      "headers": { "Authorization": "Bearer ${TM_TOKEN}" }
    }
  }
}
```

**Check it worked.** In Claude Code, run `/mcp`. `taskmanager` should be listed as **connected**, and opening it
shows its tools. Then ask for something small — "list my TaskManager boards" — which calls `list_boards` and
proves the token, not just the connection.

```bash
claude mcp list                  # what is configured, and whether it connects
claude mcp get taskmanager       # the URL, the scope, the headers (redacted)
claude mcp remove taskmanager    # take it out again
```

If `/mcp` says *failed*: the header is the usual culprit — the quotes have to survive your shell, and the token
has to start with `tm_live_`. `curl -s -H "Authorization: Bearer $TM_TOKEN" {{url:apiBase}}/me` answers the
question on its own.

## 3 · The plugin

The same MCP server, plus the two things a bare server does not carry: a **skill** that teaches Claude this
system before you have to explain it, and **slash commands** for the things you do every day.

```text
{{url:pluginZipUrl}}     the bundle, one download
{{url:pluginDirUrl}}      the same files, to read before you run them
```

Inside:

```text
.claude-plugin/plugin.json          wires the MCP server at {{url:mcpUrl}}
.claude-plugin/marketplace.json     lets the folder itself be added as a marketplace
skills/taskmanager/SKILL.md         the integration context: boards, tickets, threads, the rules
skills/taskmanager/reference/…      llms-full.txt verbatim — the whole generated reference, offline
skills/artifact/SKILL.md            how to build, run locally and publish an ARTIFACT (a small website
                                    kept inside TaskManager, with its own data)
skills/artifact/example/index.html  a complete single-file artifact, ready to publish
skills/artifact/template/…          a Vite project with the three settings that matter already right
commands/tm-inbox.md                /tm-inbox      what is waiting on you
commands/tm-triage.md               /tm-triage     a board's untriaged tickets, one pass
commands/tm-new.md                  /tm-new        a ticket from a sentence
commands/tm-ticket.md               /tm-ticket     one ticket, in full, with its thread
commands/tm-standup.md              /tm-standup    what moved, and what is stuck
```

### Install it from the marketplace command

```bash
curl -fsSL {{url:pluginZipUrl}} -o claude-plugin.zip
unzip claude-plugin.zip            # → ./claude-plugin/
```

Then, inside Claude Code:

```text
/plugin marketplace add ./claude-plugin
/plugin install taskmanager@taskmanager
```

`marketplace add` registers the folder as a source; `install` puts the plugin on. `/plugin` on its own lists what
is installed, and `/plugin uninstall taskmanager@taskmanager` removes it.

### Or point at the folder

If you would rather not register a marketplace, keep the folder anywhere and tell Claude Code about it:

```bash
claude --plugin-dir ./claude-plugin
```

Either way the plugin needs your token in the environment — it is the one thing the bundle deliberately does not
contain:

```bash
export TM_TOKEN='tm_live_…'   # in ~/.zshrc, so every session has it
```

Check with `/mcp` (the server should be **connected**) and `/help` (the five `tm-` commands should be listed).
If the commands are there but every call fails, `TM_TOKEN` was not set in the shell that started Claude.

### Keeping it current

The bundle is generated with the API it describes, so a stale copy is a copy that describes an older release.
`{{url:manifestUrl}}` carries the current `version` and `contentSha256`; when it moves, download the zip again and
re-run `/plugin marketplace add` (or just restart Claude Code, which re-reads the folder).

## What Claude can do once it is in

The same tools, whichever route you took — the connector, the command and the plugin all reach the one MCP
endpoint:

```text
{{gen:tools}}
```

Two things worth knowing before you ask for anything:

- **`board` is an argument.** With an account token, a connector grant or an agent's token on several boards, a
  call that does not name a ticket key needs to know which board it means, so `list_boards` is the natural first call and `board: 'ENG'` is how
  every other call says where. A ticket key already names its board, so `get_ticket ENG-42` needs nothing else.
- **Nothing exceeds your own access.** A tool call is checked against the boards the credential reaches *right
  now* and the role you hold on each. Claude cannot see a board you left, and it cannot do on a board something
  you could not do yourself.

## Building artifacts

An **artifact** is a small website that lives inside TaskManager — a dashboard, a tracker, a poll — shared
with the people you choose, with its own database behind one script tag. With the plugin installed, ask for
one in plain words ("build me a shared packing list as a TaskManager artifact and share it with
priya@example.com") and the `artifact` skill takes it from there: it writes the page, loads
`{{url:driver.js}}` for the backend, publishes it with `artifact_publish` and shares it with
`artifact_share`. The token needs the `artifacts:read` and `artifacts:write` scopes, which the **Full
account** preset includes (an agent's token always has them; what it may do on an artifact is the
`{ build, data }` its owner gave it there). The same skill covers the artifact's **data from outside the
page** — `artifact_data_get / list / set / batch` — so "refresh the numbers on the sales dashboard" is a
data write, not a rebuild. Without the plugin the same `artifact_*` tools are there; point Claude at §8 of
{{url:llmsFullUrl}} for the rest.

## The memory palace

An honest note, because this is the use people arrive at on their own: a TaskManager board makes a good
long-term memory for Claude, and a bad one for some things.

It is good at durable, addressable notes that accumulate a history. It is not a vector store, it does not do
semantic recall, and it will not remember anything nobody wrote down. What it gives you is better than that in
one specific way: **everything has a key, and a key survives the conversation.**

```text
a board per area            HOME, HEALTH, OCZ, READING — one board is one part of your life
a ticket per durable thing  a project, a decision, a person, a recurring question
the thread is the log       every update is a message, in order, with the date it happened
a task list is the plan     the steps, ticked off as they are done — Claude publishes and updates it
tags and fields are facets  status, area, priority — the things you will filter on later
#references, not restatement  link ENG-42 rather than paste its contents again
```

Why references beat restating: a pasted copy is a fork. It ages, it disagrees with the ticket it came from, and
the next conversation has two versions to reconcile. A key (`ENG-42`) is a pointer Claude can follow with
`get_ticket` whenever it actually needs the detail — and what it reads is what is true now.

Practical rules that hold up:

- **One ticket, one subject.** If it needs two titles, it is two tickets. Link them.
- **Write the decision, not the deliberation.** The thread keeps the deliberation; the description holds what is
  true today. Keep the description edited.
- **Close the loop.** A ticket that is done gets moved, not deleted — the history is the point.
- **Let it ask.** An agent blocked on something only you know should ask a question in the thread rather than
  guess; you answer it in the app and it carries on.
- **Keep it in the app.** Whatever Claude records here, you can read, edit and delete in a normal interface, from
  a phone, without Claude.

### Paste this into a Claude project

Project instructions, or your `CLAUDE.md` — a short, complete briefing. The last line is the one that matters:
it is one fetch, and it replaces every other explanation of how this API works.

```text
You have access to TaskManager, my ticket tracker, over MCP (tools prefixed `taskmanager`).
Treat it as my long-term memory, not as a scratchpad.

Boards are areas of my life; each has a key. Call list_boards first and use the key as the
`board` argument. A ticket key like ENG-42 already names its board. Read each board's and each
stage's description: they say what the board is for and what a stage means — that is how you
pick where a ticket goes and when to move it.

How I want you to use it:
- Before answering anything that has a history, search TaskManager for it.
- A durable fact, decision or ongoing thing becomes a ticket: a clear title, a description
  that states what is true now, and tags.
- Progress goes in the ticket's thread as a message, dated, shortest useful form.
- A plan goes in that ticket's task list, and you tick items off as they are done.
- Reference other tickets by key instead of restating them. Follow the key when you need
  the detail.
- Never invent a key. If you cannot find the ticket, search, then ask.
- Keep the description current; keep the thread append-only.

Read {{url:llmsFullUrl}} first.
```

## When something is wrong

```text
/mcp says failed              the token: quotes lost by the shell, or not an account token
401 unauthenticated           revoked, expired, regenerated since, or its agent was archived
403 forbidden                 the scope, or your role on that board — a scope never widens a role.
                              For an agent's token it is always the role: it has no scopes to add
"which board?"                a credential on several boards + no ticket key: pass board, or call list_boards
a board is missing            you are no longer on it; the credential follows your access, live
the connector cannot be added claude.ai needs the https URL exactly: {{url:mcpUrl}}
```

Deeper than this page goes: {{url:integrateUrl}} is the whole operating context for
people, and {{url:llmsFullUrl}} is the same thing as one Markdown file for a model. Every
tool above, its arguments and its errors are listed there, generated from the running software.

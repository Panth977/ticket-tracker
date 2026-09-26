## 2. How an agent gets in

An agent never signs in. It acts through a **token**, and the token carries everything: which boards,
which identity, and which permissions.

### Three kinds of credential

```text
kind             acts as              reaches
────             ───────              ───────
board · me       the person           one board
board · agent    an agent of theirs   one board
account          the person           EVERY board they are on, as it stands at each call
oauth            the person           the boards granted on the consent screen
```

A **board token** is what an orchestrator usually wants: one board, one identity, nothing to choose at
call time. An **account token** — "virtual me" — is the app without the app: it reaches every board its
owner is on *right now*, so losing access to a board loses it for the token in the same instant. Both
are `tm_live_…` strings and both go in the same `Authorization: Bearer` header; `GET /v1/me` says which
kind you hold (`kind: 'board' | 'account'`, and for an account token the boards it reaches today).

**What an account token can never do, whatever its scopes**: create or revoke tokens, grant or revoke
OAuth access, change its owner's sign-in or security settings, delete or export the account. A token can
never mint another token, so a leak cannot become permanent — revoke it and it is over.

Account tokens carry the board scopes below *on every board*, plus four of their own: `boards:create`,
`boards:admin` (only where their owner is an admin), `agents:write` and `invites:write`. The preset is
**Full account**.

### The three steps a person takes, once

1. **Make the agent.** In the app, **You › Agents › New agent**: a name, a picture, a one-line
   description and a **system prompt** in Markdown. The prompt is the agent's standing instructions,
   and it is handed to the token — an orchestrator does not need a local copy of it.
2. **Put it on a board.** A board admin who *owns* the agent adds it in **People & roles › Add
   agent**, with a role of `editor`, `commenter` or `viewer` (never `admin`), and optionally a
   *StageGrant* that limits which stages it may move tickets between.
3. **Make a token.** **Account › Tokens › New token**: a name, exactly one board, *acts as* → that
   agent, the permissions (checkboxes, or the presets *Read only* / *Worker* / *Everything*), and an
   expiry. The token string is shown **once**. It looks like `tm_live_…`. (The same screen makes an
   **account token** instead, if what you want is one credential for every board you are on.)

The same screen also hands over a ready-to-paste MCP config and curl examples, and a link to this
page for the agent itself.

### What the token carries

```text
board        a board token: exactly one, and the token IS the board.
             an account token: none — every board its owner is on, resolved at each call.
identity     'me' (the person) or an agent. Every change is authored by that principal.
scopes       what it may do — see §5.1.
expiry       never / 30 / 90 / 365 days. An expired token is 401, not 403.
```

Nothing in the API takes a board **id**. A board token names no board at all; an account token names one
by its **key** — in the path (`/v1/boards/ENG/tickets`), in the `board` argument of an MCP tool, or
implicitly, because a ticket key like `ENG-42` already says which board it belongs to.

Stored hashed; only its prefix is kept in the clear. Revoking it takes effect on the next request.
Archiving an agent, or taking it off the board, revokes its tokens for that board.

### The one rule to internalise

> **A token's power is its scopes ∩ what its principal's board role allows.**

A scope never widens a role. An agent that is a *commenter* on the board cannot move a ticket even
if its token carries `tickets:move` — it gets `403 forbidden`. An agent with a StageGrant cannot
move a ticket outside the stages it was granted. And no agent is ever a board admin, so `board:admin`
and `webhooks:manage` are only ever carried by a token that acts as a **person**.

This is deliberate: a person hands out a token without having to reason about what a scope list adds
up to. The role is the ceiling; the scopes only lower it.

### Using it

```bash
export TM_TOKEN='tm_live_…'

curl -s -H "Authorization: Bearer $TM_TOKEN" {{url:apiBase}}/me
```

`GET /v1/me` is the call to start with, always. It tells you who you are, what **kind** of credential
this is, which board you are on (or, for an account token, which boards you can reach right now), what
role you have on each, which scopes you hold, and — if the token acts as an agent — the agent's name,
description and **system prompt**. An orchestrator that reads `/v1/me` first needs no configuration
beyond the token: the same code works for a board token and an account token.

For MCP, the same string is the Bearer token on `{{url:mcpUrl}}`:

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

Interactive MCP clients may use OAuth instead of a token; the endpoint advertises it at
`/.well-known/oauth-authorization-server`. For an unattended orchestrator, use the token.

Putting this inside Claude — as a custom connector, as one `claude mcp add` command, or as the
downloadable plugin with its skill and slash commands — is a page of its own: {{url:claudeUrl}}.

## 2. How an agent gets in

An agent never signs in. It acts through a **token** — and an agent has exactly **one**. The token
says *who the agent is* and nothing else. It names no board and carries no list of permissions to
tick: it reaches every board and every artifact the agent is on, as that stands at each call, and
what the agent may do there is decided where it works — its **role** on each board, its
`{ build, data }` on each artifact.

### The kinds of credential

```text
{{gen:credentials}}
```

"Every board it is on" is read **at each call**, not remembered: join or leave a board and the very
next request sees it. An **agent token** is what an orchestrator holds. An **account token** — "virtual me" — is the same
idea for a person: the app without the app, reaching every board its owner is on *right now*. A
**board token** is one board, acting as the person who made it, narrowed by the scopes they ticked.
All three are `tm_live_…` strings in the same `Authorization: Bearer` header, and `GET /v1/me` says
which you hold (`kind: 'agent' | 'account' | 'board'`, with the boards it reaches today).

**What no token can do, whatever it is**: create or revoke tokens, grant or revoke OAuth access,
change its owner's sign-in or security settings, delete or export the account. A token can never
mint another token, so a leak cannot become permanent — regenerate it and the old one is dead.

An agent token carries no *account* scopes either: an agent cannot create boards, agents or
invites. An account token may (`boards:create`, `boards:admin` where its owner is an admin,
`agents:write`, `invites:write`; the preset is **Full account**).

### The three steps a person takes, once

1. **Make the agent.** In the app, **You › Agents › New agent**: a name, a picture, a one-line description
   and a **system prompt** in Markdown. The prompt is the agent's standing instructions, and it is
   handed to the token — an orchestrator does not need a local copy of it.
2. **Say where it works.** On the agent's own page ({{url:agentsUrl}} › the agent › **Access**), or
   from a board's **People & roles** and an artifact's **People**: every board with a role —
   `viewer`, `commenter`, `editor` or `admin` — and optionally a *StageGrant* that limits which
   stages a commenter may move tickets between; every artifact with **Build** on or off and **Data**
   `none`, `read` or `write` (§8.2). The agent's page is the one place that answers "what may this
   agent do?".
3. **Generate its token.** Same page, the **Token** card: **Generate**. The string is shown
   **once**. It looks like `tm_live_…`. There is nothing else to choose — no board, no checkboxes.
   **Regenerate** issues a new one and the old one stops working in the same moment; that is also
   how you deal with a leak.

Only the agent's owner can do step 3, only in the app, never through the API. ({{url:tokensUrl}} is
where a person makes an *account* token or a board token that acts as themselves; it lists agent
tokens read-only and points at the agent's page.)

### On a board: the role is the permission

```text
{{gen:agentroles}}
```

Each role includes the ones above it. **An agent may be an admin** — complete ownership of that
board's work. (Over the API today the admin-only calls are restoring an archived ticket and the
webhook routes; a board's stages and fields are still edited in the app, by a person.) What an agent admin still cannot do is what no agent can: manage the
board's people and agents, invite, create boards, mint tokens. Those stay with people and account
tokens.

An agent is on a board only while its **owner** is: take the owner off a board and the agent's next
call there answers `404`, like any board it is not on.

### What the token carries

```text
identity     the agent. Every change is authored by it: "Builder (agent) via token builder".
board        none. It reaches every board the agent is on, read at each call.
scopes       fixed, and not a choice (§5.1 lists them): every board scope, the two admin scopes
             and the two artifact scopes. They narrow nothing — the role does.
expiry       optional. An expired token is 401, not 403.
what stands  the agent exists, is its owner's, is not archived, and the owner is still allowed in.
behind it    Checked on every call. A board the agent left is a 404 on that board — not a dead token.
```

Stored hashed; only its prefix is kept in the clear. Archiving the agent stops its token on the next
request (`401`).

### Which board does a call mean?

A ticket key names its own board, so anything addressed by key — `GET /v1/tickets/ENG-42`,
`get_ticket`, `tm.tickets.get('ENG-42')` — needs nothing else. For a call that is about a board but
names no ticket (list tickets, create one, read the board, heartbeat), the rule is the same for an
agent token and an account token:

- the agent is on **exactly one** board → that board. Nothing to say.
- it is on **several** → the call **names the board**, by its key:

```text
REST   ?board=ENG on the call  (or the path form, /v1/boards/ENG/tickets)
MCP    the `board` argument:   { "board": "ENG", … }
SDK    createClient({ token, board: 'ENG' })   or   tm.board('ENG')
```

A call that needed a board and got none answers `400 invalid` and lists the keys it could have
meant (`options`), so a script or a model corrects itself in one step. Nothing in the API takes a
board **id**.

**Tokens converted from the old model.** Until this release an agent had one token *per board*. Those
were converted in place — same secret, nothing to re-issue — and each keeps its old board as a
**default board** (`default_board` in `GET /v1/me`): a call that names no board still lands there,
so an orchestrator written for the one-board token keeps running after its agent joins a second
board. A freshly generated token has no default. Do not build on the default — name the board.

### The one rule to internalise

> **An agent may do on a board exactly what its role there allows.** The token adds nothing and
> takes nothing away.

So `403 forbidden` always means the **role** (or the StageGrant): ask the agent's owner, or a board
admin, to raise it on the agent's page — or accept the limit. There is no token to re-mint with
more boxes ticked.

For a **person's** token the older rule still holds: its power is *its scopes ∩ what the person's
role allows*. A scope never widens a role; it only lowers the ceiling.

### Using it

```bash
export TM_TOKEN='tm_live_…'

curl -s -H "Authorization: Bearer $TM_TOKEN" {{url:apiBase}}/me
```

`GET /v1/me` is the call to start with, always. It tells you who you are, what **kind** of
credential this is, the **boards** you reach right now, `board` and `role` when a call that names no
board would land on one (null when it must name one), and — for an agent — its name, description and
**system prompt**. An orchestrator that reads `/v1/me` first needs no configuration beyond the token
and, on several boards, the key of the one it works on.

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

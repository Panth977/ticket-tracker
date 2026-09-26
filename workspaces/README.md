# workspaces — the orchestrator

One supervisor, one orch process per board, one headless Claude Code session per ticket.

```
workspaces/
  ws.mjs            the CLI and the supervisor
  lib/orch.mjs      the runtime every board shares (zero dependencies)
  lib/tm.mjs        REST client for /v1 + the wake stream from GET /v1/live
  lib/brief.md      what every agent is told; a workspace's brief.md is spliced into it
  lib/config.mjs    what a workspace may contain
  .env              TM_BASE (your deployment) and TM_ACCOUNT_TOKEN (for `ws new`)   — gitignored
  <name>/
    workspace.json  repo, board, agent, enabled, maxAgents, maxRunMin, permissionMode, model, autoResume, pollMs, stages, env
    .env            TM_TOKEN — a Worker token acting as that agent on that board   — gitignored
    brief.md        the project's rules for an unattended agent
    state/, logs/   the runtime's own files                                       — gitignored
```

`example/` is a template (disabled). Copy it or run `node ws.mjs new`.

## Commands

```
node ws.mjs up                 start the supervisor (detached); it runs one orch per enabled workspace
node ws.mjs down               stop the supervisor and every orch (running agents resume on the next up)
node ws.mjs status [ws]        what every orch is doing
node ws.mjs health             exit 1 when something is wrong
node ws.mjs logs <ws> [KEY]    the orch log, or an agent's run on a ticket
node ws.mjs restart <ws>       restart one orch (the supervisor does this by itself when its files change)
node ws.mjs validate [ws]      say what is wrong with a workspace, if anything
node ws.mjs new <name> --repo <dir> --board <KEY> --agent "<name>" [--template kanban]
node ws.mjs install|uninstall  a launchd agent so `up` survives a reboot (macOS)
```

## The loop

```
To do  ──orch claims──▶ In progress ──agent reports "review"──▶ Review ──owner──▶ Done
                            │  ▲
           agent asks a     │  │ the answer (form or a comment) resumes
           question ────────▼  │ the same session
                          waiting
```

- The orch owns the ticket's stage, the heartbeat, the event inbox and the turn receipt (one message per run with what it cost). The agent gets the tracker's MCP tools for everything else.
- The agent publishes its plan as a task list on the ticket and keeps it honest; the ticket's live dot follows it.
- A blocking question (`ask_question`) ends the agent's turn; the answer, or a comment in the thread, resumes the same session.
- Moving a ticket back to **To do** resumes the session as rework. Unassigning it, or moving it anywhere else while an agent runs, stops the agent.
- It wakes on the board's Realtime Database revision (`GET /v1/live`) and polls only where it cannot.
- Cost per turn is the difference from the session's last reported total, because Claude Code's `total_cost_usd` is cumulative across `--resume`.

The supervisor never needs a restart: editing a workspace's files restarts that orch, editing `lib/` restarts them all, a new folder with a valid `workspace.json`, `brief.md` and `.env` is started, `"enabled": false` stops one. A workspace can even point at this folder, so tickets on an "orch" board reconfigure the other boards' orchestrators.

Agents run with `permissionMode` from `workspace.json` (`acceptEdits` in the template; `bypassPermissions` if you trust the brief and the repo). They run in your working tree, unattended. Read `lib/brief.md` before enabling one.

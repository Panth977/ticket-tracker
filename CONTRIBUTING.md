# Contributing

Issues and pull requests are welcome. This started as a personal tool, so the design docs in `docs/` say what it is and, just as often, what it deliberately is not; read `docs/plan/decisions.html` before proposing a workspace, org or team layer.

## Working on it

```sh
pnpm install
pnpm dev            # emulators + seed + SPA
pnpm typecheck && pnpm lint && pnpm test
pnpm test:emu       # before a PR that touches backend/, shared/ or the rules
```

- The contracts live in `shared/`. A change to a command or a schema changes the app, the REST API, the MCP tools, the SDK and the generated docs at once; run `pnpm integrate:gen` and `pnpm sdk:build` and commit the results, or `pnpm integrate:check` will fail the deploy.
- Every write goes through a command in `backend/src/commands`. Do not add a second write path.
- The orchestrator (`workspaces/lib`) stays dependency-free.
- Formatting is Prettier (`pnpm format`); lint is ESLint (`pnpm lint`).

## Reporting a security problem

See `SECURITY.md`.

# TaskManager

A private ticket tracker for one person and the people (and AI agents) they invite,
plus the orchestrator that turns a ticket into a headless Claude Code session.

Boards hold tickets. Tickets hold a thread, files, task lists and questions. Agents are
first-class members of a board: they get a role, a token, a REST/MCP surface and, through
the `workspaces/` runtime, a working directory where they do the ticket and report back.

Everything runs on one Firebase project (Firestore, Functions, Storage, Realtime Database,
Auth, Hosting) with a SvelteKit SPA in front. The whole thing runs locally on the emulators
with a single command.

## What is in the box

| Directory | What it is |
| --- | --- |
| `shared/` | `@tm/shared` — zod schemas, the command contracts, rich-text logic, ports. Everything the backend and the app agree on. |
| `backend/` | `@tm/backend` — Cloud Functions: one `api` function with four doors (app, REST `/v1`, MCP `/mcp`, OAuth), Firestore triggers, jobs, notifications, search. |
| `frontend/` | `@tm/frontend` — the SvelteKit SPA and PWA: boards, table/calendar views, ticket threads, agents, account, analytics. |
| `sdk/` | `@tm/sdk` — a dependency-free TypeScript client, built as one file and served by the deployment at `/lib/v1/`. |
| `qaqc/` | Seed data, Firestore/Storage rules tests, Playwright suites (UI, API, phone), and an orchestrator sample that calls every SDK method. |
| `workspaces/` | The orchestrator: one supervisor, one orch process per board, one headless Claude Code session per ticket. |
| `scripts/` | Dev stack, deploy pipeline, the generator for `/llms.txt`, `/integrate` and the Claude plugin. |
| `docs/` | The design docs (served HTML, `pnpm docs`): architecture, decisions, agents, SDK, run book. |
| `infra/` | Storage CORS and the monitoring role, applied by hand. |

### Highlights

- **Boards are the only boundary.** No org, no workspaces, no teams. Anyone allowed in can create a board and invite people to it by email with a role (admin, editor, commenter, viewer).
- **One command layer.** The app, the REST API and the MCP server all execute the same commands (`backend/src/commands`), so nothing an agent can do is different from what a person can do.
- **Agents are principals.** An agent has a profile and a system prompt; a token acts as the agent on one board; every change is attributed ("Owner via Claude (MCP)").
- **Private by design.** Sign-in is open, but only addresses on the allow list can do anything. The admin is one configured address, never a role.
- **Notifications are personal.** Each person chooses events × channels (in-app, push, email, WhatsApp), quiet hours and digests. Nobody configures notifications for someone else.
- **Live without polling.** Clients read Firestore directly; agents wake on a Realtime Database revision stream (`GET /v1/live`).
- **Self-describing.** The deployment serves `/llms.txt`, `/llms-full.txt`, `/integrate`, `/integrate.json`, `/v1/openapi.json`, the SDK at `/lib/` and a Claude Code plugin at `/lib/claude-plugin.zip`, all generated from the same schemas the routes parse with.

## Run it locally

Requirements: Node 22.12+, pnpm 9, Java 21 (for the Firebase emulators), and the Firebase CLI (`npm i -g firebase-tools`).

```sh
pnpm install
pnpm dev
```

`pnpm dev` builds the shared package and the functions, starts the emulators (auth, Firestore, RTDB, Storage, Functions, Tasks), seeds demo data and serves the SPA at http://127.0.0.1:5190. Sign in with any email; under the emulators every address is allowed unless a document says otherwise.

Other commands:

```sh
pnpm typecheck        # every package
pnpm lint             # eslint
pnpm test             # unit tests (vitest) in every package
pnpm test:emu         # the emulator suites (backend, rules, API) — slow, needs Java 21
pnpm e2e              # Playwright, against a running `pnpm dev`
pnpm docs             # the design docs at http://127.0.0.1:4321
pnpm sdk:build        # sdk/dist — the one-file SDK, its types and the npm tarball
pnpm integrate:gen    # regenerate /llms*.txt, /integrate*, the Claude plugin
```

## Deploy it

1. Create a Firebase project on the Blaze plan. Enable Firestore, Realtime Database, Storage, Authentication (Google and email link) and Identity Platform (the `beforeSignIn` blocking function needs it).
2. `firebase use --add` and name the alias `prod`. The deploy scripts read it from `.firebaserc`.
3. Copy `frontend/.env.production.example` to `frontend/.env.production` and fill in the web app config from the Firebase console. Set `PUBLIC_TM_ADMIN_EMAIL` to your address.
4. Copy `backend/.env.example` to `backend/.env.<your-project-id>`. Set `TM_REGION`, `APP_URL`, `API_URL`, `TM_ADMIN_EMAIL` and `TM_WEB_API_KEY` (the same public key as the SPA's).
5. Provider credentials (email, WhatsApp, Typesense, GitHub webhooks) go to Secret Manager: `firebase functions:secrets:set NAME`, then list the name in `TM_SECRETS`. Everything not configured stays off.
6. `pnpm deploy:prod` — builds the SPA, packages the functions and simulates Cloud Build on the package, stages the SDK and the integration pages for your URLs, then runs `firebase deploy`. `--dry-run` stops before the deploy. Plain `firebase deploy` is blocked by a predeploy guard on purpose: `firebase.json` is the emulator config.

The run book with every environment variable, the Firebase console steps and the cost notes is `docs/plan/run.html` (`pnpm docs`).

## Give an agent a ticket

`workspaces/` is the orchestrator. A workspace is a folder with `workspace.json` (which repo, which board, which agent, how many agents at once), `.env` (a Worker token for that agent) and `brief.md` (the project's rules for an unattended agent). The supervisor runs one orch per enabled workspace and restarts it when its files change.

```sh
cp workspaces/.env.example workspaces/.env          # TM_BASE (your deployment) + an account token
node workspaces/ws.mjs new myproject --repo ~/src/myproject --board MYP --agent "Claude MyProject"
# mint a Worker token for that agent in the app (Account › Tokens), put it in workspaces/myproject/.env
node workspaces/ws.mjs up
node workspaces/ws.mjs status
```

Assign a ticket on that board to the agent and move it to **To do**. The orch claims it, starts a headless Claude Code session in the repo with the tracker's MCP tools, publishes the agent's plan as a task list on the ticket, relays questions back and forth through the thread, posts a cost receipt per turn, and moves the ticket to **Review** when the agent reports done. Moving it back to **To do** resumes the same session as rework. See `workspaces/README.md`.

The runtime has zero dependencies and is about a thousand lines: `workspaces/lib/orch.mjs` (the loop), `workspaces/lib/tm.mjs` (REST client and wake stream), `workspaces/lib/brief.md` (what every agent is told).

## Use it from code

```ts
import { createClient } from 'https://<your-project-id>.web.app/lib/v1/sdk.ts';

// The token decides the board and who the client acts as (you, or one of your agents).
const tm = createClient({ token: process.env.TM_TOKEN!, baseUrl: 'https://<your-project-id>.web.app' });
const mine = await tm.tickets.list({ assignee: 'me', state: 'active' });
const ticket = await tm.tickets.create({ title: 'Rotate the signing key' });
await tm.messages.post(ticket.key, { markdown: 'On it.' });
```

Every token is scoped to one board and acts either as you or as one of your agents. The REST API is at `/v1` (OpenAPI 3.1 at `/v1/openapi.json`), MCP at `/mcp` with the same Bearer token or OAuth for interactive clients. `sdk/README.md` has the full client reference.

## Configuration that is yours

Nothing in the repository names a project, a person or a secret. What you provide:

| Where | What |
| --- | --- |
| `.firebaserc` | the `prod` alias |
| `frontend/.env.production` | the Firebase web config, `PUBLIC_TM_ADMIN_EMAIL`, optional `PUBLIC_FCM_VAPID_KEY` |
| `backend/.env.<project>` | region, URLs, `TM_ADMIN_EMAIL`, the names of the secrets to bind |
| Secret Manager | provider credentials |
| `workspaces/.env`, `workspaces/*/.env` | `TM_BASE`, the account token, one Worker token per workspace |

The committed copies of the generated integration files (`frontend/static/llms*.txt`, `/integrate*`, the plugin) and the SDK's default base URL use the placeholder project `taskmanager-example`; a deploy regenerates them for yours.

## License

MIT — see `LICENSE`.

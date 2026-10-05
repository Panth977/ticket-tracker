# TaskManager

A private ticket tracker for one person and the people (and AI agents) they invite.

Boards hold tickets. Tickets hold a thread, files, task lists and questions. Agents are
first-class members of a board: they get a role, a token and a REST/MCP surface, so an
orchestrator (or Claude itself, as a connector) can pick up a ticket, do it and report back.
Artifacts are small sandboxed web apps (dashboards, tools) that live next to your boards and
can read and write their tickets.

Everything runs on one Firebase project (Firestore, Functions, Storage, Realtime Database,
Auth, Hosting) with a SvelteKit SPA in front. The whole thing runs locally on the emulators
with a single command.

## What is in the box

| Directory | What it is |
| --- | --- |
| `shared/` | `@tm/shared` — zod schemas, the command contracts, rich-text logic, ports. Everything the backend and the app agree on. |
| `backend/` | `@tm/backend` — Cloud Functions: one `api` function with four doors (app, REST `/v1`, MCP `/mcp`, OAuth), Firestore triggers, jobs, notifications, search. |
| `frontend/` | `@tm/frontend` — the SvelteKit SPA and PWA: boards, table/calendar views, ticket threads, agents, artifacts, workspaces, account, analytics. `frontend/mcp-ui/` is the board/ticket view rendered inside Claude chats (MCP Apps). |
| `driver/` | `@tm/backend-driver` — `window.BackendDriver`, the API an artifact's page uses for its own data, files and (when granted) board tickets. |
| `sdk/` | `@tm/sdk` — a dependency-free TypeScript client, built as one file and served by the deployment at `/lib/v1/`. |
| `qaqc/` | Seed data, Firestore/Storage rules tests, Playwright suites (UI, API, phone), and an orchestrator sample that calls every SDK method. |
| `scripts/` | Dev stack, deploy pipeline, the generator for `/llms.txt`, `/integrate` and the Claude plugin. |
| `docs/` | The design docs (served HTML, `pnpm docs`): architecture, decisions, agents, SDK, run book. |
| `infra/` | Storage CORS and the monitoring role, applied by hand. |

### Highlights

- **Boards are the only boundary.** No org, no teams. Anyone allowed in can create a board and invite people to it by email with a role (admin, editor, commenter, viewer). A *workspace* is only your own sidebar grouping of boards and artifacts; it grants nothing.
- **Claude as the client.** `/mcp` is an OAuth 2.1 custom connector: add it in the Claude app and every command the web app has is a tool, with boards and tickets rendered inline in the chat.
- **Artifacts.** Publish a static site (a dashboard, a form) as an artifact; it runs sandboxed on a second Hosting site, keeps its own data and files, and reads or writes the tickets of the boards you grant it.
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

An agent is a member of a board with its own token. Anything that speaks REST or MCP can work its tickets: claim one, post its plan as a task list, ask questions in the thread, move it to **Review**. `GET /v1/live` is a wake stream, so an orchestrator does not poll. `qaqc/orch-sample/` is a small orchestrator that exercises every SDK method; `docs/plan/agents.html` describes the full loop.

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

The committed copies of the generated integration files (`frontend/static/llms*.txt`, `/integrate*`, the plugin) and the SDK's default base URL use the placeholder project `taskmanager-example`; a deploy regenerates them for yours.

## License

MIT — see `LICENSE`.

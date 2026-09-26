# tm-orch-sample

A real orchestrator on the hosted SDK, and the consumer project that proves the
types arrive (docs/plan/agents.html §M).

It is deliberately _not_ a workspace package: it installs `@tm/sdk` from the
built tarball, the way somebody outside this repo does, so nothing it compiles
against comes from the monorepo.

```
src/orchestrator.ts   the orchestrator: tm.work() → task list → question →
                      files → message, heartbeating the whole way
src/every-method.ts   never runs; it is compiled. Every method with an explicit
                      type on the answer, then a list of @ts-expect-error lines
                      for mistakes the compiler must refuse
check.mjs             install the tarball, inspect the package, tsc --strict,
                      run the result
```

## Run the check

```sh
pnpm orch:sample              # from the repo root (node qaqc/orch-sample/check.mjs)
node qaqc/orch-sample/check.mjs --build      # build the SDK first if dist/ is missing
node qaqc/orch-sample/check.mjs --if-needed  # skip if dist/ is already newer than everything
```

The compile is the test. A wrong field type is an error, and each
`@ts-expect-error` line fails the build if the mistake it describes turns out to
compile — which is also what happens if the types never resolved at all, so "no
types" cannot pass as "types fine".

## Run the orchestrator

Make a **Worker** token in Account › Tokens that acts as one of your agents, on
a board the agent is on, then:

```sh
cd qaqc/orch-sample
npm install                              # @tm/sdk from the tarball
npm run build
TM_TOKEN=tm_live_… TM_BASE_URL=https://taskmanager-example.web.app npm start
```

| Variable                                     | Default          | What it does                                                   |
| -------------------------------------------- | ---------------- | -------------------------------------------------------------- |
| `TM_TOKEN`                                   | —                | required; the token decides the board and the identity         |
| `TM_BASE_URL`                                | the hosted build | the app's origin (the emulator's, in tests)                    |
| `TM_MAX_EVENTS`                              | `1`              | stop after N events; `0` runs forever                          |
| `TM_CURSOR`                                  | —                | resume the inbox from this event id                            |
| `TM_ANSWER_TIMEOUT_MS` / `TM_ANSWER_POLL_MS` | 30 min / 5 s     | waiting for the question to be answered                        |
| `TM_HEARTBEAT_MS`                            | 60 000           | beat interval — the UI calls an agent stale after 75 s         |
| `TM_POLL`                                    | —                | `1` forces the polling fallback instead of the live connection |
| `TM_MIN_POLL_MS` / `TM_MAX_POLL_MS`          | 2 000 / 60 000   | the backoff when polling is all there is                       |

## What it costs while it waits (§W)

Nothing. `tm.work()` runs on `tm.watch()`: ONE streaming connection to the
Realtime Database node the command layer bumps when something changes, and a
REST call only then — asking for the delta (`cursor` + `unacked` on the inbox),
never for the world. An idle orchestrator makes no requests at all.

This matters because the opposite was measured on the live deployment: two
orchestrators polling every ~30 seconds were **88 % of every request the API
served**, each one a full scan, almost all of them answering "nothing new".
Where a live connection cannot be opened the SDK still polls — but on a
backoff, a couple of seconds while work is arriving and a minute when it is
not — and `TM_POLL=1` forces that path so you can see it.

`tm.events.stream()` (`transport: 'stream'`) is still there and still works. It
holds a Cloud Run request open, and Cloud Run bills a request's CPU for its
whole life, waiting included — so an always-connected agent on it is the most
expensive thing this API offers. This sample does not use it.

Assign a ticket to the agent and it wakes up: it publishes a plan, asks how the
report should look, waits for a person to answer the form in the app, writes
`report.md` and `report.html`, posts them as one message, and finishes. Every
step prints one JSON line, so `| jq` is a live log.

`qaqc/e2e/ui/sdk-orchestrator.spec.ts` runs this exact file against the
emulators while a browser answers the question.

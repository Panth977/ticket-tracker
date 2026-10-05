#!/usr/bin/env node
/**
 * §AA6 data migration (docs/plan/agents.html §AA) — ONE TOKEN PER AGENT, for
 * a database that predates it.
 *
 * Old tokens keep working the moment §AA ships (a board token acting as an
 * agent is still resolved as before). This makes the data say what the new
 * model means. What it does — the code is backend/src/agents/tokenMigration.ts,
 * imported from the BUILT backend so the key format, the scopes and the
 * derivations are the backend's own and cannot drift:
 *
 *   (a) every LIVE key acting as an agent → kind 'agent', boardId null,
 *       defaultBoardId = its old board, scopes = AGENT_TOKEN_SCOPES.
 *       Same secret, same hash: nothing has to be re-issued.
 *   (b) boards get `agentIds` (derived from `access`).
 *   (c) artifacts' `agents` values become { build, data }.
 *   (d) an agent with MORE THAN ONE live token is issued ONE new agent token,
 *       '<agent name> (agent token)', with no default board. Its secret is
 *       written ONLY to ./.agent-tokens/<agentId>.txt (mode 0600, git-ignored)
 *       — never to the terminal. Move the agent's callers onto it, then use
 *       "Revoke older tokens" on the agent's page.
 *
 * IT REVOKES NOTHING. It never prints a hash or a secret.
 *
 * DRY RUN BY DEFAULT: it prints exactly what would change and writes nothing.
 * --apply writes. IDEMPOTENT: a second run changes nothing and mints nothing.
 *
 *   pnpm --filter @tm/shared build && pnpm --filter @tm/backend build
 *   node scripts/migrate-agent-tokens.mjs --project <id>            # dry run
 *   node scripts/migrate-agent-tokens.mjs --project <id> --apply    # write
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8380 node scripts/migrate-agent-tokens.mjs --project demo-taskmanager
 *
 * Credentials: application-default (`gcloud auth application-default login`),
 * or the emulator when FIRESTORE_EMULATOR_HOST is set. --project is REQUIRED:
 * this script never guesses which database it is about to change.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
let project = '';
let apply = false;
let outDir = resolve(process.cwd(), '.agent-tokens');

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project' || a === '-P') project = argv[++i] ?? '';
  else if (a.startsWith('--project=')) project = a.slice('--project='.length);
  else if (a === '--apply') apply = true;
  else if (a === '--dry-run' || a === '-n') apply = false;
  else if (a === '--out') outDir = resolve(process.cwd(), argv[++i] ?? '');
  else if (a.startsWith('--out=')) outDir = resolve(process.cwd(), a.slice('--out='.length));
  else {
    console.error(`migrate-agent-tokens: unknown argument ${a}`);
    process.exit(2);
  }
}
if (!project) {
  console.error(
    'migrate-agent-tokens: --project <id> is required (it never guesses which database to change)',
  );
  process.exit(2);
}

// The backend's Admin SDK bootstrap (runtime/firebase.ts) reads the project
// from the environment — set it BEFORE the backend is imported.
process.env.GCLOUD_PROJECT = project;
process.env.GOOGLE_CLOUD_PROJECT = project;
process.env.METADATA_SERVER_DETECTION ||= 'none';

const log = (m = '') => console.log(`\x1b[34mmigrate\x1b[0m │ ${m}`);

const coreFile = fileURLToPath(new URL('../backend/lib/agents/tokenMigration.js', import.meta.url));
if (!existsSync(coreFile)) {
  console.error(
    'migrate-agent-tokens: backend/lib is not built. Run:\n' +
      '  pnpm --filter @tm/shared build && pnpm --filter @tm/backend build',
  );
  process.exit(2);
}
const { planAgentTokenMigration, applyAgentTokenMigration } = await import(
  pathToFileURL(coreFile).href
);

/** ./.agent-tokens/<agentId>.txt, 0600, in a 0700 folder. The ONLY place a secret goes. */
function writeSecret(agentId, key) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);
  const file = resolve(outDir, `${agentId}.txt`);
  // 'wx' would refuse an old file; a rerun never mints twice, so a file here
  // is from an earlier, DIFFERENT token of the same agent — replace it whole.
  rmSync(file, { force: true });
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function print(plan) {
  log(`keys to convert to agent tokens: ${plan.keys.length}`);
  for (const k of plan.keys)
    log(
      `  ${k.path}  ${k.prefix}…  "${k.name}"  agent ${k.agentId}  → kind 'agent', boardId null, defaultBoardId ${k.defaultBoardId ?? 'null'}, scopes AGENT_TOKEN_SCOPES`,
    );
  log(`boards to backfill agentIds: ${plan.boards.length}`);
  for (const b of plan.boards)
    log(`  boards/${b.boardId} (${b.key})  agentIds = [${b.agentIds.join(', ')}]`);
  log(`artifacts to rewrite agents: ${plan.artifacts.length}`);
  for (const a of plan.artifacts)
    log(
      `  artifacts/${a.artifactId} ("${a.name}")  ${a.rewritten
        .map((id) => `${id}: 'editor' → ${JSON.stringify(a.agents[id])}`)
        .join('; ')}`,
    );
  log(`agents issued one new token (more than one live token today): ${plan.mints.length}`);
  for (const m of plan.mints)
    log(
      `  ${m.agentId} ("${m.agentName}", owner ${m.ownerUid})  ${m.liveKeys} live tokens  → new token "${m.name}", secret to ${resolve(outDir, `${m.agentId}.txt`)} (0600)`,
    );
}

async function main() {
  const where = process.env.FIRESTORE_EMULATOR_HOST
    ? ` (emulator ${process.env.FIRESTORE_EMULATOR_HOST})`
    : '';
  log(`project ${project}${where} — ${apply ? 'APPLY' : 'dry run (nothing is written; --apply to write)'}`);
  const now = Date.now();
  const plan = await planAgentTokenMigration(now);
  print(plan);
  const total = plan.keys.length + plan.boards.length + plan.artifacts.length + plan.mints.length;
  if (total === 0) {
    log('nothing to do — already migrated');
    return;
  }
  if (!apply) {
    log('dry run: nothing was written. Re-run with --apply to write.');
    return;
  }
  const res = await applyAgentTokenMigration(plan, now, writeSecret);
  log(
    `done: ${res.keys} key(s) converted, ${res.boards} board(s) backfilled, ${res.artifacts} artifact(s) rewritten, ${res.minted.length} token(s) minted. Nothing was revoked.`,
  );
  for (const m of res.minted)
    log(
      `  minted "${m.name}" (${m.prefix}…, users/${m.ownerUid}/apiKeys/${m.keyId}) — secret in ${resolve(outDir, `${m.agentId}.txt`)}`,
    );
  if (res.minted.length)
    log(`the secrets are ONLY in ${outDir}/ — move them somewhere safe, then delete the folder.`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`migrate-agent-tokens: ${e?.stack ?? e}`);
    process.exit(1);
  },
);

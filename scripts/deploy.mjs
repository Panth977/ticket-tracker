#!/usr/bin/env node
/**
 * `pnpm deploy:prod` — build everything for production and deploy it.
 *
 *   1. check frontend/.env.production (the real PUBLIC_FIREBASE_* values)
 *   2. build the SPA: `vite build` (mode production loads .env.production)
 *   3. package the functions → backend/deploy/ + firebase.deploy.json and
 *      simulate Cloud Build on it (scripts/deploy-functions.mjs --verify)
 *   4. stage the hosted SDK into the build: frontend/build/lib/{v1,latest}/
 *      (scripts/deploy-lib.mjs — refuses a missing or stale sdk/dist)
 *   5. the integration context — /llms.txt, /llms-full.txt, /integrate,
 *      /integrate.json (scripts/gen-integration.mjs). The COMMITTED copy must
 *      equal a fresh generation, or the deploy stops: a page that describes
 *      yesterday's API is worse than no page. Then a copy for THIS project's
 *      URLs is staged into the build.
 *   6. firebase deploy --config firebase.deploy.json --project <id>
 *      (hosting — BOTH sites: the app and the artifact usercontent site,
 *      docs/plan/artifacts.html §D1 — functions, firestore rules + indexes,
 *      storage, database rules)
 *
 * The usercontent site ({project}-usercontent) has to exist before the first
 * deploy that includes hosting. It is created once, by hand:
 *   firebase hosting:sites:create <id>-usercontent --project <id>
 *
 *   pnpm deploy:prod                         everything to the "prod" alias in .firebaserc
 *   pnpm deploy:prod --only functions,hosting   any firebase --only list
 *   pnpm deploy:prod --only hosting          both sites; hosting:<site id> for one
 *   pnpm deploy:prod --dry-run               steps 1–4 only: build + verify + stage, no deploy
 *   pnpm deploy:prod --build-sdk             rebuild sdk/dist instead of failing on a stale one
 *   pnpm deploy:prod --project <id>          another project (needs backend/.env.<id>)
 *
 * Every other argument is passed to `firebase deploy` (e.g. --force, --debug).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDotenv } from './deploy-functions.mjs';
import { DEFAULT_PROJECT, isPlaceholder } from './project.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);

let project = process.env.TM_DEPLOY_PROJECT || DEFAULT_PROJECT;
let dryRun = false;
const passthrough = [];
// Flags for step 4 (scripts/deploy-lib.mjs); never passed to `firebase deploy`.
const libFlags = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project' || a === '-P') project = argv[++i];
  else if (a.startsWith('--project=')) project = a.slice('--project='.length);
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--build-sdk') libFlags.push('--build');
  else if (a === '--stale-ok') libFlags.push('--stale-ok');
  else passthrough.push(a);
}

const step = (m) => console.log(`\n\x1b[34mdeploy\x1b[0m │ ${m}`);
const fail = (m) => {
  console.error(`\n\x1b[31mdeploy\x1b[0m │ ${m}`);
  process.exit(1);
};
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed (${r.status ?? r.signal})`);
}

if (project.startsWith('demo-')) fail(`${project} is the emulator project — nothing to deploy to`);
if (isPlaceholder(project))
  fail('no production project: add a "prod" alias to .firebaserc (firebase use --add), or pass --project <id>');

// 1. frontend env
step(`project ${project}${dryRun ? ' (dry run: no deploy)' : ''}`);
const envFile = join(ROOT, 'frontend', '.env.production');
if (!existsSync(envFile))
  fail('frontend/.env.production is missing — copy frontend/.env.production.example and fill it in');
const fe = readDotenv(envFile);
for (const k of [
  'PUBLIC_FIREBASE_API_KEY',
  'PUBLIC_FIREBASE_AUTH_DOMAIN',
  'PUBLIC_FIREBASE_PROJECT_ID',
  'PUBLIC_FIREBASE_STORAGE_BUCKET',
  'PUBLIC_FIREBASE_APP_ID',
]) {
  if (!fe[k]) fail(`frontend/.env.production: ${k} is empty`);
}
if (fe.PUBLIC_FIREBASE_PROJECT_ID !== project)
  fail(`frontend/.env.production is for ${fe.PUBLIC_FIREBASE_PROJECT_ID}, not ${project}`);
if (/^(1|true|yes|on)$/i.test(fe.PUBLIC_USE_EMULATORS ?? ''))
  fail('frontend/.env.production: PUBLIC_USE_EMULATORS must be false');
if (!existsSync(join(ROOT, 'backend', `.env.${project}`)))
  fail(`backend/.env.${project} is missing (TM_REGION, APP_URL …)`);

// 2. SPA
step('building the SPA (vite build --mode production)');
run('pnpm', ['--filter', '@tm/shared', 'build']);
run('pnpm', ['--filter', '@tm/frontend', 'build'], {
  // A shell-exported PUBLIC_* (e.g. from pnpm dev) would override .env.production.
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PUBLIC_'))),
});

// 3. functions package + Cloud Build simulation
// The chat UI (MCP Apps) is a file the api function serves: rebuild it so the
// deployed function never carries a stale copy of the view.
step('building the chat UI (frontend/mcp-ui → backend mcpUiHtml.gen.ts)');
run('pnpm', ['--filter', '@tm/frontend', 'mcp-ui:build']);

step('packaging functions → backend/deploy (verify = npm install --omit=dev + load)');
run(process.execPath, [join(ROOT, 'scripts', 'deploy-functions.mjs'), '--project', project, '--verify']);

// 4. the hosted SDK → frontend/build/lib/{v1,latest}/
// After the functions step on purpose: openapi.json is generated from the
// backend that was just built, so what /lib ships describes what /v1 will serve.
step('staging the hosted SDK → frontend/build/lib (agents.html §M)');
run(process.execPath, [join(ROOT, 'scripts', 'deploy-lib.mjs'), '--project', project, ...libFlags]);

// 5. the integration context: guard the committed copy, then stage this project's.
//
// The GUARD runs without --project on purpose: what is committed under
// frontend/static/ is always the canonical project's URLs, so checking it
// against another project's would fail for the wrong reason. The STAGE does
// take --project, so a deploy to a second project publishes its own URLs.
step('the integration context → /llms*.txt, /integrate, /integrate.json (agents.html §O)');
run(process.execPath, [join(ROOT, 'scripts', 'gen-integration.mjs'), '--check']);
run(process.execPath, [join(ROOT, 'scripts', 'gen-integration.mjs'), '--project', project, '--out', 'frontend/build']);

// 6. deploy
const deployArgs = ['deploy', '--config', 'firebase.deploy.json', '--project', project, ...passthrough];
if (dryRun) {
  step(`dry run — would now run: firebase ${deployArgs.join(' ')}`);
  process.exit(0);
}
step(`firebase ${deployArgs.join(' ')}`);
run('firebase', deployArgs);
step('done');

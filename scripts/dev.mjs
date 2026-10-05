#!/usr/bin/env node
/**
 * `pnpm dev` — the whole app on this machine, one command:
 *
 *   1. build @tm/shared + @tm/backend once (the functions emulator loads backend/lib)
 *   2. tsc --watch for both, so the functions emulator hot-reloads on save
 *   3. firebase emulators:start (auth, firestore, database, storage, functions, tasks + UI)
 *   4. seed demo data once the `api` function answers (qaqc/seed/seed.ts)
 *   5. vite dev for the SPA on http://127.0.0.1:5190 (proxies /api, /v1, /mcp … to the api)
 *
 * Flags:
 *   --no-seed    start empty
 *   --no-web     emulators + watchers only (e.g. to run the SPA yourself)
 *   --persist    keep emulator data in .emulator-data between runs (import + export on exit);
 *                seeding is skipped when data was imported
 *
 * Ctrl-C stops everything (the emulators get SIGINT so --persist can export).
 * Every env var in the backend/frontend (see docs/plan/run.html) passes through.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PORTS, PROJECT_ID, ROOT, URLS } from './ports.mjs';

const args = new Set(process.argv.slice(2));
const SEED = !args.has('--no-seed');
const WEB = !args.has('--no-web');
const PERSIST = args.has('--persist');
const DATA_DIR = join(ROOT, '.emulator-data');

// firebase-tools 15 needs Java 21; Homebrew's keg-only openjdk@21 is not on PATH by default.
const PATH = ['/opt/homebrew/opt/openjdk@21/bin', '/usr/local/opt/openjdk@21/bin', process.env.PATH].join(':');
const env = {
  ...process.env,
  PATH,
  // Links in mail / push / WhatsApp and ticket urls point at the dev SPA; REST/MCP
  // discovery documents advertise the SPA origin too (vite proxies those paths).
  APP_URL: process.env.APP_URL ?? URLS.web,
  API_URL: process.env.API_URL ?? URLS.web,
  // Artifact files (docs/plan/artifacts.html §D) are served from ANOTHER origin
  // than the app, as in production — here the functions emulator's own URL for
  // `api`, whose /c/{capability}/… route streams them. The backend's default
  // under the emulators is this same URL (backend/src/artifacts/capability.ts).
  TM_ARTIFACT_ORIGIN: process.env.TM_ARTIFACT_ORIGIN ?? URLS.api,
  // Webhooks saved as https://*.webhook.test/… are delivered here instead
  // (backend/src/platform/net.ts; the e2e receiver listens on it).
  TM_DEV_WEBHOOK_SINK: process.env.TM_DEV_WEBHOOK_SINK ?? URLS.webhookSink,
  FORCE_COLOR: '1',
};

const COLORS = { tsc: 36, emu: 35, seed: 33, web: 32, dev: 34 };
function out(tag, line) {
  process.stdout.write(`\x1b[${COLORS[tag] ?? 37}m${tag.padEnd(4)}\x1b[0m │ ${line}\n`);
}

const children = new Set();
function run(tag, cmd, argv, opts = {}) {
  const child = spawn(cmd, argv, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  children.add(child);
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) out(tag, l);
    });
  }
  child.on('exit', (code, sig) => {
    children.delete(child);
    if (!stopping) {
      out('dev', `${tag} exited (${sig ?? code}) — stopping everything`);
      stop(code || 1);
    }
  });
  return child;
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  out('dev', 'stopping…');
  for (const c of children) c.kill(c.spawnargs.includes('emulators:start') ? 'SIGINT' : 'SIGTERM');
  const deadline = setTimeout(() => {
    for (const c of children) c.kill('SIGKILL');
    process.exit(code);
  }, 20_000);
  const tick = setInterval(() => {
    if (children.size === 0) {
      clearInterval(tick);
      clearTimeout(deadline);
      process.exit(code);
    }
  }, 200);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

function sh(tag, cmd, argv) {
  out(tag, `$ ${cmd} ${argv.join(' ')}`);
  const r = spawnSync(cmd, argv, { cwd: ROOT, env, stdio: 'inherit' });
  if (r.status !== 0) {
    out('dev', `${cmd} ${argv.join(' ')} failed (${r.status})`);
    process.exit(r.status ?? 1);
  }
}

async function portBusy(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
    return true;
  } catch (e) {
    return e?.cause?.code !== 'ECONNREFUSED';
  }
}

/** Resolves once the api function is loaded (any answer but the emulator's 404). */
async function waitForApi(timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !stopping) {
    try {
      const r = await fetch(`${URLS.api}/api/ping`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      if (r.status !== 404 && r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ── 0. ports free? ──────────────────────────────────────────────────────────
const wanted = { ...PORTS };
if (!WEB) delete wanted.web;
delete wanted.hosting; // not started in dev
delete wanted.webhookSink; // a receiver may already be listening — that is the point
const busy = [];
for (const [name, port] of Object.entries(wanted)) if (await portBusy(port)) busy.push(`${name}:${port}`);
if (busy.length) {
  out('dev', `ports already in use: ${busy.join(', ')} — is another \`pnpm dev\` (or an e2e run) still up?`);
  process.exit(1);
}

// ── 1. one-off build ────────────────────────────────────────────────────────
sh('tsc', 'pnpm', ['--filter', '@tm/shared', 'build']);
sh('tsc', 'pnpm', ['--filter', '@tm/backend', 'build']);

// ── 2. watchers ─────────────────────────────────────────────────────────────
const tsc = join(ROOT, 'node_modules/.bin/tsc');
run('tsc', tsc, ['-b', 'shared', '--watch', '--preserveWatchOutput']);
run('tsc', tsc, ['-p', 'backend/tsconfig.json', '--watch', '--preserveWatchOutput']);

// ── 3. emulators ────────────────────────────────────────────────────────────
const imported = PERSIST && existsSync(join(DATA_DIR, 'firebase-export-metadata.json'));
run('emu', 'firebase', [
  'emulators:start',
  '--project',
  PROJECT_ID,
  '--only',
  'auth,firestore,database,storage,functions,tasks',
  ...(PERSIST ? ['--export-on-exit', DATA_DIR] : []),
  ...(imported ? ['--import', DATA_DIR] : []),
]);

out('dev', 'waiting for the api function…');
if (!(await waitForApi())) {
  out('dev', 'the api function never came up — see the emu output above');
  stop(1);
} else {
  // ── 4. seed ─────────────────────────────────────────────────────────────
  if (SEED && !imported) {
    const seed = run('seed', 'pnpm', ['--filter', '@tm/qaqc', 'exec', 'tsx', 'seed/seed.ts']);
    children.delete(seed); // a finished seed is not a crash
    seed.removeAllListeners('exit');
    await new Promise((r) => seed.on('exit', r));
  }

  // ── 5. web ──────────────────────────────────────────────────────────────
  if (WEB) run('web', 'pnpm', ['--filter', '@tm/frontend', 'dev']);

  out('dev', '');
  out('dev', `  app          ${URLS.web}${WEB ? '' : '  (not started: --no-web)'}`);
  out('dev', `  emulator UI  ${URLS.ui}`);
  out('dev', `  api          ${URLS.api}`);
  if (SEED && !imported) {
    out('dev', '  sign in as   ada@demo.test or grace@demo.test with "Email me a sign-in link":');
    out('dev', '               the auth emulator prints the link above ("To sign in as …")');
  }
  out('dev', '');
}

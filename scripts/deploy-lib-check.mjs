#!/usr/bin/env node
/**
 * Prove the `/lib/**` and integration-context headers really come out of
 * Firebase Hosting (§M and §O) — and that the Claude guide and plugin bundle
 * (§R3) are served at all, dot-directory and zip included.
 *
 * The headers in firebase.json are a claim; this is the check. It starts the
 * REAL hosting emulator on the real config, then fetches every artefact and
 * asserts what a consumer actually depends on:
 *
 *   Content-Type   .ts / .d.ts → application/typescript      (hosting guesses
 *                  .js → text/javascript                      video/mp2t for
 *                  .tgz → application/gzip                    .ts otherwise)
 *   Cache-Control  /lib/v1/** immutable for a year, /lib/latest/** no-store
 *   CORS           Access-Control-Allow-Origin: * on everything under /lib
 *   Types          X-TypeScript-Types on sdk.js and sdk.min.js, pointing at
 *                  the .d.ts in the SAME channel — this is the one that makes
 *                  `import … from 'https://…/lib/v1/sdk.js'` typed in Deno
 *
 * It also checks the bytes (the bundle's triple-slash reference, the gzip
 * magic number, that openapi.json parses) and that firebase.deploy.json — the
 * config a production deploy actually uses — carries the same header block.
 *
 *   node scripts/lock.mjs emulators -- node scripts/deploy-lib-check.mjs
 *
 *   --config <file>   which config to serve (default firebase.json)
 *   --port <n>        hosting port (default: the emulators block, else 5050)
 *   --assert          skip the emulator; just check a server already running
 *   --base <url>      what --assert should talk to (default http://127.0.0.1:<port>)
 *
 * The emulator holds a port, so run it under the emulators lock. `--only
 * hosting` means the rewrites to the `api` function have nothing behind them;
 * nothing here asks for one.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { check } from './gen-integration.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : dflt;
};

const CONFIG = opt('--config', 'firebase.json');
const cfg = JSON.parse(readFileSync(join(ROOT, CONFIG), 'utf8'));
const PORT = Number(opt('--port', cfg.emulators?.hosting?.port ?? 5050));
const BASE = opt('--base', `http://127.0.0.1:${PORT}`);
const PROJECT = 'demo-taskmanager';

const version = JSON.parse(readFileSync(join(ROOT, 'sdk', 'package.json'), 'utf8')).version;

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};
const eq = (label, actual, expected) =>
  actual === expected ? ok(`${label} — ${actual}`) : bad(`${label} — expected ${expected}, got ${actual ?? '(none)'}`);
const has = (label, actual, needle) =>
  (actual ?? '').includes(needle) ? ok(`${label} — ${actual}`) : bad(`${label} — expected it to contain "${needle}", got ${actual ?? '(none)'}`);

const TYPES = {
  '.ts': 'application/typescript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.tgz': 'application/gzip',
};

/** The cache rule each channel promises. */
const CACHE = {
  v1: 'public, max-age=31536000, immutable',
  latest: 'no-store',
};

function typeOf(name) {
  if (name.endsWith('.d.ts') || name.endsWith('.ts')) return TYPES['.ts'];
  if (name.endsWith('.js')) return TYPES['.js'];
  if (name.endsWith('.tgz')) return TYPES['.tgz'];
  if (name.endsWith('.json')) return TYPES['.json'];
  return null;
}

async function head(path) {
  // GET, not HEAD: the body is checked too, and a header that only appears on
  // GET would be a header a consumer never receives.
  //
  // One retry, on a fresh connection: the emulator occasionally drops a
  // keep-alive socket mid-body ('terminated'), and a flaky check nobody trusts
  // is worse than no check at all.
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`${BASE}${path}`, { redirect: 'manual', headers: { connection: 'close' } });
    } catch (e) {
      if (attempt >= 2) throw new Error(`GET ${path} failed: ${e.message}`, { cause: e });
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function checkChannel(channel) {
  console.log(`\n/lib/${channel}/`);
  const files = ['sdk.js', 'sdk.min.js', 'sdk.ts', 'sdk.d.ts', 'tm-sdk.tgz', `tm-sdk-${version}.tgz`, 'openapi.json', 'sdk.json'];
  for (const f of files) {
    const path = `/lib/${channel}/${f}`;
    try {
      await checkFile(channel, f, path);
    } catch (e) {
      bad(`${path} — ${e.message}`);
    }
  }
}

async function checkFile(channel, f, path) {
  {
    const res = await head(path);
    if (res.status !== 200) {
      bad(`${path} — HTTP ${res.status}`);
      return;
    }
    const h = res.headers;
    eq(`${path} content-type`, h.get('content-type'), typeOf(f));
    eq(`${path} cache-control`, h.get('cache-control'), CACHE[channel]);
    eq(`${path} access-control-allow-origin`, h.get('access-control-allow-origin'), '*');
    eq(`${path} x-content-type-options`, h.get('x-content-type-options'), 'nosniff');

    // The type hint, on the bundles only.
    if (f === 'sdk.js' || f === 'sdk.min.js') eq(`${path} x-typescript-types`, h.get('x-typescript-types'), `/lib/${channel}/sdk.d.ts`);
    else if (h.get('x-typescript-types')) bad(`${path} should not send x-typescript-types`);

    // The bytes.
    if (f === 'sdk.js' || f === 'sdk.min.js') {
      const text = await res.text();
      if (text.startsWith('/// <reference types="./sdk.d.ts" />')) ok(`${path} starts with the triple-slash reference`);
      else bad(`${path} does not start with the triple-slash reference`);
    } else if (f.endsWith('.tgz')) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) ok(`${path} is gzip (${(bytes.length / 1024).toFixed(0)} kB)`);
      else bad(`${path} is not gzip — first bytes ${bytes[0]} ${bytes[1]}`);
    } else if (f === 'openapi.json') {
      const doc = await res.json();
      if (doc.openapi?.startsWith('3.1') && Object.keys(doc.paths ?? {}).length)
        ok(`${path} is OpenAPI ${doc.openapi} with ${Object.keys(doc.paths).length} paths`);
      else bad(`${path} is not a usable OpenAPI document`);
    } else if (f === 'sdk.json') {
      const m = await res.json();
      eq(`${path} version`, m.version, version);
    } else if (f === 'sdk.d.ts') {
      const text = await res.text();
      if (/^\s*import\s/m.test(text)) bad(`${path} has an import statement — it must be flat`);
      else ok(`${path} is a flat declaration file`);
    } else {
      await res.arrayBuffer();
    }
  }
}

async function checkIndex() {
  console.log('\n/lib/');
  // Both spellings: what people type, and the file itself.
  for (const path of ['/lib/', '/lib/index.html']) {
    let res;
    try {
      res = await head(path);
    } catch (e) {
      bad(`${path} — ${e.message}`);
      continue;
    }
    if (res.status !== 200) {
      bad(`${path} — HTTP ${res.status}`);
      continue;
    }
    has(`${path} content-type`, res.headers.get('content-type'), 'text/html');
    eq(`${path} cache-control`, res.headers.get('cache-control'), 'no-cache');
    eq(`${path} access-control-allow-origin`, res.headers.get('access-control-allow-origin'), '*');
    const html = await res.text();
    // The index must be the static install page, not the SPA's fallback.
    if (html.includes('@tm/sdk') && !html.includes('sveltekit')) ok(`${path} is the static install page (not the SPA fallback)`);
    else bad(`${path} did not serve frontend/static/lib/index.html`);
  }
}


/**
 * The integration context an orchestrator is pointed at (§O). The promises a
 * consumer depends on: plain text with an explicit charset, never cached (the
 * whole point of re-reading it is to find out whether it changed), and
 * fetchable from anywhere.
 */
async function checkIntegration() {
  console.log('\n/llms*.txt, /integrate, /integrate.json');
  // The contracts, from the BUILT package: scripts/ has no @tm/shared dependency
  // of its own, and adding one just to read two arrays would be silly.
  const { MCP_TOOLS, REST_ROUTES } = await import(pathToFileURL(join(ROOT, 'shared', 'dist', 'index.js')).href);
  const expect = [
    ['/llms.txt', 'text/plain; charset=utf-8', 'no-store'],
    ['/llms-full.txt', 'text/plain; charset=utf-8', 'no-store'],
    ['/integrate.json', 'application/json; charset=utf-8', 'no-store'],
    // Three spellings of the readable page: what people type, the normalised
    // directory, and the file itself.
    ['/integrate', 'text/html', 'no-cache'],
    ['/integrate/', 'text/html', 'no-cache'],
    ['/integrate/index.html', 'text/html', 'no-cache'],
  ];
  for (const [path, type, cache] of expect) {
    let res;
    try {
      res = await head(path);
    } catch (e) {
      bad(`${path} — ${e.message}`);
      continue;
    }
    // Hosting answers /integrate with a 301 to /integrate/; follow it once.
    if (res.status === 301 || res.status === 308) {
      const to = res.headers.get('location');
      ok(`${path} → ${res.status} ${to}`);
      res = await head(new URL(to, BASE).pathname);
    }
    if (res.status !== 200) {
      bad(`${path} — HTTP ${res.status}`);
      continue;
    }
    has(`${path} content-type`, res.headers.get('content-type'), type);
    eq(`${path} cache-control`, res.headers.get('cache-control'), cache);
    eq(`${path} access-control-allow-origin`, res.headers.get('access-control-allow-origin'), '*');

    const text = await res.text();
    if (path === '/llms-full.txt') {
      // The content, not just the headers: this is the file agents actually read.
      const missing = [
        ...REST_ROUTES.map((r) => `${r.method} ${r.path}`),
        ...Object.keys(MCP_TOOLS).map((t) => `#### ${t}`),
      ].filter((needle) => !text.includes(needle));
      if (missing.length) bad(`${path} is missing ${missing.length} entries, e.g. ${missing.slice(0, 3).join(', ')}`);
      else ok(`${path} documents all ${REST_ROUTES.length} REST routes and ${Object.keys(MCP_TOOLS).length} MCP tools (${(text.length / 1024).toFixed(0)} kB)`);
    } else if (path === '/integrate.json') {
      const m = JSON.parse(text);
      eq(`${path} version`, m.version, version);
      if (m.apiBase && m.mcpUrl && m.openapiUrl && m.llmsFullUrl && m.sdk?.esm && m.scopes?.length && m.events?.length)
        ok(`${path} manifest is complete (${m.scopes.length} scopes, ${m.events.length} events)`);
      else bad(`${path} manifest is missing one of apiBase / mcpUrl / openapiUrl / llmsFullUrl / sdk / scopes / events`);
    } else if (type === 'text/html') {
      if (text.includes('Integrate TaskManager') && !text.includes('sveltekit')) ok(`${path} is the static page (not the SPA fallback)`);
      else bad(`${path} did not serve frontend/build/integrate/index.html`);
    }
  }

  await checkClaude();

  // The committed copy must equal a fresh generation — the same guard the
  // deploy runs, checked here so `pnpm lib:check` catches it too.
  try {
    const res = await check({});
    if (res.stale.length) bad(`the committed integration context is stale: ${res.stale.map((f) => f.path).join(', ')} — run: pnpm integrate:gen`);
    else ok(`the committed integration context matches a fresh generation (updated ${res.updated})`);
  } catch (e) {
    bad(`could not regenerate the integration context: ${e.message}`);
  }
}

/**
 * TaskManager inside Claude (§R3): the setup guide, the plugin folder and the
 * zip. The zip is the one that actually needs a live server — a bundle served
 * as text/html, or gzipped by a proxy, is a bundle that will not open, and no
 * amount of reading firebase.json proves otherwise. The `.claude-plugin/`
 * directory is fetched on purpose: a dotfile glob in hosting's `ignore` would
 * silently leave the plugin's manifest out of the deploy.
 */
async function checkClaude() {
  console.log('\n/integrate/claude, /lib/claude-plugin*');
  const expect = [
    ['/integrate/claude', 'text/html', 'no-cache'],
    ['/integrate/claude/', 'text/html', 'no-cache'],
    ['/integrate/claude/index.html', 'text/html', 'no-cache'],
    ['/lib/claude-plugin/README.md', 'text/markdown; charset=utf-8', 'no-cache'],
    ['/lib/claude-plugin/skills/taskmanager/SKILL.md', 'text/markdown; charset=utf-8', 'no-cache'],
    ['/lib/claude-plugin/commands/tm-inbox.md', 'text/markdown; charset=utf-8', 'no-cache'],
    // No cache/CORS assertion on this one: hosting's header globs do not match a
    // path segment that starts with a dot, so `.claude-plugin/**` gets the
    // defaults. It is still SERVED (the `ignore` list no longer drops dotfiles),
    // which is the thing that actually matters — this file is the plugin.
    ['/lib/claude-plugin/.claude-plugin/plugin.json', 'application/json', null],
  ];
  for (const [path, type, cache] of expect) {
    let res;
    try {
      res = await head(path);
    } catch (e) {
      bad(`${path} — ${e.message}`);
      continue;
    }
    if (res.status === 301 || res.status === 308) {
      const to = res.headers.get('location');
      ok(`${path} → ${res.status} ${to}`);
      res = await head(new URL(to, BASE).pathname);
    }
    if (res.status !== 200) {
      bad(`${path} — HTTP ${res.status}`);
      continue;
    }
    has(`${path} content-type`, res.headers.get('content-type'), type);
    if (cache) {
      eq(`${path} cache-control`, res.headers.get('cache-control'), cache);
      eq(`${path} access-control-allow-origin`, res.headers.get('access-control-allow-origin'), '*');
    }
    const text = await res.text();
    if (path.endsWith('plugin.json')) {
      const m = JSON.parse(text);
      if (m.mcpServers?.taskmanager?.url?.endsWith('/mcp')) ok(`${path} wires the MCP server`);
      else bad(`${path} does not wire an MCP server`);
    } else if (type === 'text/html') {
      if (text.includes('TaskManager in Claude') && !text.includes('sveltekit')) ok(`${path} is the static guide (not the SPA fallback)`);
      else bad(`${path} did not serve frontend/build/integrate/claude/index.html`);
    }
  }

  // The bundle: real zip bytes, not an error page wearing a .zip name.
  try {
    const res = await head('/lib/claude-plugin.zip');
    if (res.status !== 200) bad(`/lib/claude-plugin.zip — HTTP ${res.status}`);
    else {
      has('/lib/claude-plugin.zip content-type', res.headers.get('content-type'), 'application/zip');
      eq('/lib/claude-plugin.zip cache-control', res.headers.get('cache-control'), 'no-cache');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
        ok(`/lib/claude-plugin.zip is a zip (${(buf.length / 1024).toFixed(0)} kB, PK\\x03\\x04)`);
      else bad('/lib/claude-plugin.zip does not start with the zip magic number');
    }
  } catch (e) {
    bad(`/lib/claude-plugin.zip — ${e.message}`);
  }
}

/** The production deploy uses firebase.deploy.json; the headers must survive the generation. */
function checkDeployConfig() {
  console.log('\nfirebase.deploy.json');
  const p = join(ROOT, 'firebase.deploy.json');
  if (!existsSync(p)) {
    console.log('  – not generated yet (run scripts/deploy-functions.mjs); skipped');
    return;
  }
  const gen = JSON.parse(readFileSync(p, 'utf8'));
  const a = JSON.stringify([].concat(gen.hosting ?? [])[0]?.headers ?? null);
  const b = JSON.stringify([].concat(cfg.hosting ?? [])[0]?.headers ?? null);
  if (a === b) ok('the /lib headers survive into the generated deploy config');
  else bad('firebase.deploy.json hosting.headers differ from firebase.json — regenerate it');
}

async function waitForServer(ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/lib/v1/sdk.json`);
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function assertAll() {
  console.log(`checking ${BASE} (config ${CONFIG}, @tm/sdk ${version})`);
  await checkIndex();
  for (const channel of ['v1', 'latest']) await checkChannel(channel);
  await checkIntegration();
  checkDeployConfig();
  console.log(failures ? `\n\x1b[31m${failures} header check(s) failed\x1b[0m\n` : '\n\x1b[32mevery /lib header, content type and byte checked out\x1b[0m\n');
  return failures === 0;
}

async function main() {
  if (!existsSync(join(ROOT, 'frontend', 'build', 'lib', 'v1', 'sdk.js')))
    throw new Error('frontend/build/lib is not staged — run: node scripts/deploy-lib.mjs');

  if (flag('--assert')) return (await assertAll()) ? 0 : 1;

  // emulators:exec would need a command; a long-running start + kill keeps the
  // assertions in THIS process, where their output is readable.
  const emu = spawn(
    'firebase',
    ['emulators:start', '--only', 'hosting', '--project', PROJECT, '--config', CONFIG],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  emu.stdout.on('data', (d) => (log += d));
  emu.stderr.on('data', (d) => (log += d));
  try {
    if (!(await waitForServer())) {
      console.error(log);
      throw new Error(`the hosting emulator never answered on ${BASE}`);
    }
    return (await assertAll()) ? 0 : 1;
  } finally {
    emu.kill('SIGTERM');
    // Give it a moment to let the port go, so a following run is not refused.
    await new Promise((r) => setTimeout(r, 1200));
    if (!emu.killed) emu.kill('SIGKILL');
  }
}

process.exit(
  await main().catch((e) => {
    console.error(`\n\x1b[31mlib-check\x1b[0m │ ${e.message}\n`);
    return 1;
  }),
);

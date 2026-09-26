/**
 * Prove the type hints, one fixture project per runtime (§M, "Type hints in
 * every runtime"). Nothing here trusts the build's word for it:
 *
 *   node   — `npm i` the real tarball into a project of its own, then
 *            `tsc --strict` it, and import it at runtime.
 *   deno   — `deno check` a script that imports dist/sdk.ts over HTTP.
 *   deno   — `deno check` a script that imports dist/sdk.js over HTTP from a
 *            server that sends X-TypeScript-Types, the way hosting will.
 *
 * Each fixture ends with `@ts-expect-error` lines. They fail if the mistake
 * compiles — and ALSO if the types never resolved at all, because then the
 * expected error never happens and TypeScript reports the unused directive.
 * "No types" therefore cannot pass as "types fine".
 *
 *   node fixtures/check.mjs [--only=node|deno]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const sdk = dirname(here);
const dist = join(sdk, 'dist');
const work = join(sdk, '.fixtures');

const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const say = (m) => console.log(m);

/**
 * ASYNC on purpose: the local hosting stand-in runs in THIS process, so a
 * blocking spawnSync would deadlock the moment Deno asked it for a module.
 */
function run(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ ok: false, out: `${out}${e.message}`, status: -1 }));
    child.on('close', (status) => resolve({ ok: status === 0, out, status }));
  });
}

function must(label, r) {
  if (!r.ok) {
    console.error(`\n✗ ${label}\n${r.out}`);
    process.exitCode = 1;
    throw new Error(label);
  }
  say(`  ✓ ${label}`);
}

// ── the local hosting stand-in ──────────────────────────────────────────────

/**
 * Serves dist/ with the content types and headers §M specifies: .ts and
 * .d.ts as application/typescript, CORS open, and — the whole point —
 * `X-TypeScript-Types` on sdk.js.
 */
const TYPES = {
  '.ts': 'application/typescript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.tgz': 'application/gzip',
};

function serveDist() {
  const server = createServer(async (req, res) => {
    const name = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '').replace(/^\//, '');
    // The negative control: the same bundle with BOTH type hints taken away
    // (no triple-slash reference, no X-TypeScript-Types). checkDeno asserts
    // that a script importing this one FAILS to check — otherwise the two
    // checks above would pass just as happily with no types at all.
    // Two variants of the bundle with its triple-slash reference removed, so
    // the X-TypeScript-Types header can be judged on its own:
    //   header-only.js — no reference, header sent   → must type-check
    //   untyped.js     — no reference, no header     → must NOT type-check
    if (name === 'untyped.js' || name === 'header-only.js') {
      const js = await readFile(join(dist, 'sdk.js'), 'utf8');
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('content-type', TYPES['.js']);
      if (name === 'header-only.js') res.setHeader('x-typescript-types', './sdk.d.ts');
      res.writeHead(200).end(js.replace('/// <reference types="./sdk.d.ts" />', ''));
      return;
    }
    const file = join(dist, name);
    if (!file.startsWith(dist) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = file.endsWith('.d.ts') ? '.ts' : extname(file);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', TYPES[ext] ?? 'application/octet-stream');
    // A URL import only carries types if the server says where they are.
    if (name === 'sdk.js' || name === 'sdk.min.js') res.setHeader('x-typescript-types', './sdk.d.ts');
    res.writeHead(200).end(await readFile(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ── node: install the tarball, then tsc --strict ────────────────────────────

async function checkNode(version) {
  say('node (npm tarball + tsc --strict)');
  const dir = join(work, 'node');
  const tarball = join(dist, `tm-sdk-${version}.tgz`);
  if (!existsSync(tarball)) throw new Error(`no tarball at ${tarball} — run \`pnpm --filter @tm/sdk build\` first`);

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(join(here, 'node', 'main.ts'), join(dir, 'main.ts'));
  await cp(join(here, 'node', 'tsconfig.json'), join(dir, 'tsconfig.json'));
  // A project of its own: nothing but the tarball, exactly as a user gets it.
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'tm-sdk-node-fixture', private: true, version: '0.0.0', type: 'module', dependencies: { '@tm/sdk': `file:${tarball}` } }, null, 2),
  );

  must('npm install the tarball', await run('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: dir }));

  const installed = JSON.parse(await readFile(join(dir, 'node_modules', '@tm', 'sdk', 'package.json'), 'utf8'));
  if (installed.version !== version) throw new Error(`the tarball installed version ${installed.version}, expected ${version}`);
  if (installed.dependencies && Object.keys(installed.dependencies).length)
    throw new Error(`the tarball must have no runtime dependencies, but declares ${Object.keys(installed.dependencies).join(', ')}`);
  if (Object.keys(installed.exports['.'])[0] !== 'types') throw new Error('the exports map must list `types` first');
  say('  ✓ the package declares types, an exports map (types first) and no dependencies');

  // tsc resolves '@tm/sdk' from node_modules, exactly as an editor would.
  const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  must('tsc --strict (including every @ts-expect-error)', await run(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { cwd: dir }));

  must(
    'node imports the installed package',
    await run(process.execPath, ['--input-type=module', '-e', `import { createClient, VERSION } from '@tm/sdk'; if (VERSION !== ${JSON.stringify(version)}) throw new Error('wrong version ' + VERSION); if (typeof createClient !== 'function') throw new Error('no createClient');`], {
      cwd: dir,
    }),
  );
}

// ── deno: check both URL imports ────────────────────────────────────────────

async function checkDeno(origin, port) {
  say('deno (URL imports)');
  const deno = await run('deno', ['--version']);
  if (!deno.ok) {
    say('  – deno is not installed; skipped');
    return;
  }
  const dir = join(work, 'deno');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  for (const [file, label, swap] of [
    ['from-ts.ts', 'deno check — import sdk.ts (Deno types the source itself)', null],
    ['from-js.ts', 'deno check — import sdk.js (triple-slash reference + X-TypeScript-Types)', null],
    // The same script against a bundle with no reference line: only the
    // header can be carrying the types now.
    ['from-js.ts', 'deno check — import sdk.js with ONLY the X-TypeScript-Types header', 'header-only.js'],
  ]) {
    const source = (await readFile(join(here, 'deno', file), 'utf8'))
      .replaceAll('__ORIGIN__/sdk.js', `${origin}/${swap ?? 'sdk.js'}`)
      .replaceAll('__ORIGIN__', origin);
    const name = swap ? `header-only-${file}` : file;
    await writeFile(join(dir, name), source);
    must(label, await run('deno', ['check', '--quiet', '--reload', `--allow-import=127.0.0.1:${port}`, '--no-lock', join(dir, name)], { cwd: dir }));
  }

  // The control: strip both type hints and the very same script must FAIL,
  // because its `@ts-expect-error` lines stop being errors and TypeScript
  // reports the unused directives. Without this, "types resolved" and "the
  // module came through as `any`" would look identical.
  const control = (await readFile(join(here, 'deno', 'from-js.ts'), 'utf8'))
    .replaceAll('__ORIGIN__/sdk.js', `${origin}/untyped.js`)
    .replaceAll('__ORIGIN__', origin);
  await writeFile(join(dir, 'untyped.ts'), control);
  const negative = await run('deno', ['check', '--quiet', '--reload', `--allow-import=127.0.0.1:${port}`, '--no-lock', join(dir, 'untyped.ts')], { cwd: dir });
  must('the same script fails when the type hints are taken away (the control)', { ok: !negative.ok, out: 'deno check PASSED against an untyped bundle — the checks above prove nothing' });
}

// ── go ──────────────────────────────────────────────────────────────────────

const { version } = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8'));
say(`@tm/sdk ${version} — proving the type hints`);

const { server, port } = await serveDist();
const origin = `http://127.0.0.1:${port}`;
try {
  if (only !== 'deno') await checkNode(version);
  if (only !== 'node') await checkDeno(origin, port);
} finally {
  server.close();
}
if (!process.exitCode) say('✓ Node, Deno-from-.ts and Deno-from-.js all resolve the types');

#!/usr/bin/env node
/**
 * The sample consumer project, proved end to end at the type level (§M).
 *
 * This is what a person outside the repo does — `npm i` the tarball and point
 * `tsc --strict` at their own code — with nothing of the monorepo reaching in:
 *
 *   1. the tarball from sdk/dist is installed into node_modules/@tm/sdk,
 *      exactly as `npm i https://…/lib/v1/tm-sdk.tgz` would install it
 *   2. the installed package is inspected: the version it claims, no runtime
 *      dependencies, and an `exports` map whose FIRST condition is `types`
 *   3. `tsc -p tsconfig.json` compiles src/ — src/orchestrator.ts (the real
 *      orchestrator, emitted to dist/ for the e2e to run) and
 *      src/every-method.ts, which calls every method with explicit types and
 *      ends in a list of `@ts-expect-error` lines. A wrong field type must
 *      fail to compile, so each of those lines is itself an error if the
 *      mistake turns out to be allowed — and if the types never resolved at
 *      all, none of them errors and the unused directives fail the build.
 *      "No types" therefore cannot pass as "types fine".
 *   4. Node imports the compiled orchestrator, and running it without a token
 *      exits 2 with the message a person should see.
 *
 * OFFLINE BY DESIGN. Only `dependencies` are installed (the file: tarball),
 * and the two devDependencies a consumer would install from npm — typescript
 * and @types/node — are borrowed from the monorepo's own node_modules
 * afterwards. Nothing here talks to a registry, and the compiler is the same
 * pinned one the rest of the repo uses.
 *
 *   node qaqc/orch-sample/check.mjs [--build] [--if-needed] [--quiet]
 *
 *   --build       run `pnpm sdk:build` first instead of failing on a missing tarball
 *   --if-needed   skip install + compile when dist/ is already newer than everything
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const sdkDir = join(repo, 'sdk');
const tarball = join(sdkDir, 'dist', 'tm-sdk.tgz');
const modules = join(here, 'node_modules');
const installed = join(modules, '@tm', 'sdk');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const quiet = has('--quiet');
const say = (m) => void (quiet || console.log(m));

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ ok: false, out: out + e.message, status: -1 }));
    child.on('close', (status) => resolve({ ok: status === 0, out, status }));
  });
}

function must(label, r) {
  if (!r.ok) {
    console.error(`\n✗ ${label}\n${r.out}`);
    throw new Error(label);
  }
  say(`  ✓ ${label}`);
}

const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);

/** Is dist/ already newer than the tarball and every source of ours? */
function fresh() {
  const built = mtime(join(here, 'dist', 'orchestrator.js'));
  if (!built || !existsSync(installed)) return false;
  const inputs = [
    tarball,
    join(here, 'tsconfig.json'),
    join(here, 'package.json'),
    join(here, 'src', 'orchestrator.ts'),
    join(here, 'src', 'every-method.ts'),
  ];
  return inputs.every((f) => mtime(f) <= built);
}

// ── 0 · the tarball ─────────────────────────────────────────────────────────

if (!existsSync(tarball)) {
  if (!has('--build')) {
    console.error(
      `✗ no SDK tarball at ${relative(repo, tarball)} — run \`pnpm sdk:build\` (or pass --build)`,
    );
    process.exit(1);
  }
  must('pnpm sdk:build', await run('pnpm', ['sdk:build'], { cwd: repo }));
}

const version = JSON.parse(await readFile(join(sdkDir, 'package.json'), 'utf8')).version;

if (has('--if-needed') && fresh()) {
  say(`tm-orch-sample — already built against @tm/sdk ${version}`);
  process.exit(0);
}

say(`tm-orch-sample — a consumer project on @tm/sdk ${version}`);

// ── 1 · install the tarball, exactly as a consumer gets it ──────────────────

// A stale copy of a previous tarball would make step 2 lie — and npm happily
// reuses one when the lock file says the version has not changed, which it
// never does for a file: dependency that is rebuilt in place.
await rm(installed, { recursive: true, force: true });
await rm(join(here, 'package-lock.json'), { force: true });
await rm(join(modules, '.package-lock.json'), { force: true });
must(
  'npm install the tarball (dependencies only — nothing from a registry)',
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], { cwd: here }),
);

// ── 2 · what the installed package promises ─────────────────────────────────

const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
if (pkg.version !== version)
  throw new Error(`the tarball installed version ${pkg.version}, expected ${version}`);
if (pkg.dependencies && Object.keys(pkg.dependencies).length)
  throw new Error(
    `the SDK must have no runtime dependencies, but declares ${Object.keys(pkg.dependencies).join(', ')}`,
  );
if (Object.keys(pkg.exports['.'])[0] !== 'types')
  throw new Error(
    'the exports map must list `types` first, or an editor resolves the .js and gives up',
  );
if (!existsSync(join(installed, pkg.types)))
  throw new Error(`the package points at ${pkg.types}, which is not in it`);
say('  ✓ one flat .d.ts, an exports map with `types` first, and no runtime dependencies');

// ── 3 · the two devDependencies, borrowed rather than downloaded ────────────

const typescript = dirname(require.resolve('typescript/package.json'));
const nodeTypes = join(repo, 'qaqc', 'node_modules', '@types', 'node');
await mkdir(join(modules, '@types'), { recursive: true });
await rm(join(modules, '@types', 'node'), { recursive: true, force: true });
await symlink(nodeTypes, join(modules, '@types', 'node'), 'dir');

// ── 4 · tsc --strict over src/ ──────────────────────────────────────────────

must(
  'tsc --strict (every method, and every @ts-expect-error must really be an error)',
  await run(process.execPath, [join(typescript, 'bin', 'tsc'), '-p', join(here, 'tsconfig.json')], {
    cwd: here,
  }),
);

// ── 5 · and it runs ─────────────────────────────────────────────────────────

const entry = join(here, 'dist', 'orchestrator.js');
must(
  'node imports the compiled orchestrator',
  await run(process.execPath, [
    '--input-type=module',
    '-e',
    `const m = await import(${JSON.stringify(pathToFileURL(entry).href)}); if (typeof m.main !== 'function') throw new Error('no main()');`,
  ]),
);
const noToken = await run(process.execPath, [entry], {
  cwd: here,
  env: { ...process.env, TM_TOKEN: '' },
});
must('without TM_TOKEN it exits 2 and says what to do', {
  ok: noToken.status === 2 && /TM_TOKEN is required/.test(noToken.out),
  out: `expected exit 2 with the TM_TOKEN message, got ${noToken.status}:\n${noToken.out}`,
});

say(`✓ tm-orch-sample type-checks and runs against @tm/sdk ${version}`);

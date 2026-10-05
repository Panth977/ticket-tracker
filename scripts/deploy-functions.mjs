#!/usr/bin/env node
/**
 * Package the backend for Cloud Functions → backend/deploy/ (generated; never edit).
 *
 * WHY: backend/package.json depends on "@tm/shared": "workspace:*", which the
 * Cloud Build that installs a function's dependencies cannot resolve. So the
 * deploy does not upload backend/ — it uploads backend/deploy/:
 *
 *   lib/index.js        ONE esbuild ESM bundle of backend/lib (the tsc output
 *                       every test runs against) with @tm/shared INLINED and
 *                       every npm package left EXTERNAL (installed by Cloud Build)
 *   package.json        generated: only the npm packages the bundle imports,
 *                       pinned to the exact versions installed here; no
 *                       workspace deps, no devDependencies
 *   .env, .env.<proj>   copied from backend/ (non-secret config; TM_REGION …)
 *
 * AUTOLOAD. At runtime backend/lib discovers handler modules by listing
 * lib/commands, lib/jobs, … (runtime/autoload.ts). A bundle has no such
 * directories, so the bundle's entry imports every one of those modules
 * statically BEFORE lib/index.js — each registers itself exactly as
 * autoloadSync() would have made it, and autoloadSync() then finds no
 * directories (lib/../commands does not exist) and adds nothing.
 *
 * Also writes firebase.deploy.json at the repo root: firebase.json with
 * functions.source → backend/deploy, the hosting rewrites pointed at the
 * functions' region (TM_REGION from backend/.env.<project>), the emulator
 * block and the "use pnpm deploy:prod" guards removed. The dev setup keeps
 * using firebase.json (source backend/, lib/ hot-reloaded by the emulator).
 *
 * TWO HOSTING SITES (docs/plan/artifacts.html §D1). firebase.json names them
 * by TARGET ('app', 'usercontent'), which the CLI resolves through
 * .firebaserc — a file that only knows the projects somebody listed in it.
 * The deploy config therefore carries the real SITE ids instead
 * (hostingSites): the project's default site, and {project}-usercontent. So
 * `pnpm deploy:prod --project <other>` needs no .firebaserc entry, and
 * `--only hosting` deploys both sites (`--only hosting:<site id>` just one).
 *
 *   node scripts/deploy-functions.mjs [--project <id>] [--verify] [--skip-build]
 *
 *   --verify      then simulate Cloud Build: `npm install --omit=dev` in
 *                 backend/deploy and import the bundle in a clean Node,
 *                 listing its exports and comparing them with backend/lib's
 *   --skip-build  reuse backend/lib + shared/dist as they are
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BACKEND = join(ROOT, 'backend');
const SHARED = join(ROOT, 'shared');
const LIB = join(BACKEND, 'lib');
export const OUT = join(BACKEND, 'deploy');
export const DEPLOY_CONFIG = join(ROOT, 'firebase.deploy.json');
import { DEFAULT_PROJECT } from './project.mjs';

export { DEFAULT_PROJECT };

// Keep in sync with backend/src/runtime/autoload.ts.
const AUTOLOAD_DIRS = ['commands', 'jobs', 'triggers', 'doors', 'doors/hooks'];
// Always installed, even if (somehow) not imported: the Functions runtime needs them.
const ALWAYS = ['firebase-functions', 'firebase-admin'];

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const log = (m) => console.log(`\x1b[36mfunctions\x1b[0m │ ${m}`);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function run(cmd, argv, cwd = ROOT, env = process.env) {
  const r = spawnSync(cmd, argv, { cwd, stdio: 'inherit', env });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status ?? r.signal})`);
}

/** Parse a dotenv file (KEY=VALUE, # comments, optional quotes). */
export function readDotenv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Deploy-time values the bundle inlines (see bundle()). */
export function deployDefines(project) {
  const env = { ...readDotenv(join(BACKEND, '.env')), ...readDotenv(join(BACKEND, `.env.${project}`)) };
  return {
    'process.env.TM_REGION': JSON.stringify(env.TM_REGION || 'us-central1'),
    'process.env.TM_SECRETS': JSON.stringify(env.TM_SECRETS || ''),
    // Phase 17: GET /v1/live exchanges a custom token at the Identity Toolkit,
    // which needs the project's (public) web API key.
    'process.env.TM_WEB_API_KEY': JSON.stringify(env.TM_WEB_API_KEY || ''),
  };
}

/** The functions' region for a project: TM_REGION from backend/.env.<project> (or .env). */
export function regionFor(project) {
  return (
    readDotenv(join(BACKEND, `.env.${project}`)).TM_REGION ||
    readDotenv(join(BACKEND, '.env')).TM_REGION ||
    'us-central1'
  );
}

function autoloadModules() {
  return AUTOLOAD_DIRS.flatMap((dir) => {
    let names;
    try {
      names = readdirSync(join(LIB, dir));
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.js') && !/\.(test|spec)\./.test(n))
      .filter((n) => !n.startsWith('_') && n !== 'index.js')
      .sort()
      .map((n) => join(LIB, dir, n));
  });
}

const pkgName = (spec) => {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};
const isBuiltin = (spec) => spec.startsWith('node:') || builtinModules.includes(pkgName(spec));

/** Exact installed version of `name` as seen from `fromDir` (pnpm symlinks direct deps). */
function installedVersion(name, fromDir) {
  const p = join(fromDir, 'node_modules', name, 'package.json');
  return existsSync(p) ? readJson(p).version : null;
}

async function bundle(project) {
  const { build } = await import(
    // esbuild is a backend devDependency; resolve it from there.
    new URL(`file://${join(BACKEND, 'node_modules', 'esbuild', 'lib', 'main.js')}`).href
  );
  const entry = [
    '// generated by scripts/deploy-functions.mjs — handler modules first (see autoload)',
    ...autoloadModules().map((f) => `import ${JSON.stringify('./' + relative(LIB, f))};`),
    "export * from './index.js';",
    '',
  ].join('\n');

  const externals = new Set();
  const result = await build({
    stdin: { contents: entry, resolveDir: LIB, sourcefile: 'deploy-entry.js', loader: 'js' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: join(OUT, 'lib', 'index.js'),
    sourcemap: 'linked',
    sourcesContent: false,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
    // The Firebase CLI analyses the code (to learn each function's region and
    // secrets) WITHOUT the .env.<project> values, so they are inlined here.
    // Otherwise every function is analysed as us-central1 and a storage trigger
    // on an asia-south1 bucket is refused.
    define: deployDefines(project),
    // Plain Node resolution: @tm/shared → shared/dist (its "import" export).
    conditions: ['node', 'import'],
    plugins: [
      {
        name: 'npm-external',
        setup(b) {
          // Bare specifiers other than @tm/shared stay imports; Cloud Build installs them.
          b.onResolve({ filter: /^[^./]/ }, (a) => {
            if (a.path === '@tm/shared' || a.path.startsWith('@tm/shared/')) return undefined;
            if (isBuiltin(a.path)) return { path: a.path, external: true };
            externals.add(pkgName(a.path));
            return { path: a.path, external: true };
          });
        },
      },
    ],
  });
  if (result.errors.length) throw new Error('esbuild failed');
  const inputs = Object.keys(result.metafile.inputs);
  if (!inputs.some((i) => i.includes('shared/dist/')))
    throw new Error('@tm/shared was not inlined — check the shared build');
  return [...externals].sort();
}

function writePackageJson(externals) {
  const backendPkg = readJson(join(BACKEND, 'package.json'));
  const sharedPkg = readJson(join(SHARED, 'package.json'));
  const deps = {};
  for (const name of new Set([...ALWAYS, ...externals])) {
    if (name.startsWith('@tm/')) throw new Error(`workspace package ${name} leaked into the bundle's imports`);
    const from = backendPkg.dependencies?.[name]
      ? BACKEND
      : sharedPkg.dependencies?.[name]
        ? SHARED
        : null;
    if (!from)
      throw new Error(
        `the bundle imports "${name}", which is not a dependency of @tm/backend or @tm/shared`,
      );
    const v = installedVersion(name, from);
    if (!v) throw new Error(`${name} is not installed under ${relative(ROOT, from)} — run pnpm install`);
    deps[name] = v;
  }
  const pkg = {
    name: 'tm-functions',
    version: '0.0.0',
    private: true,
    description: 'GENERATED by scripts/deploy-functions.mjs from backend/ — do not edit.',
    type: 'module',
    main: 'lib/index.js',
    engines: { node: backendPkg.engines?.node ?? '22' },
    dependencies: Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  return pkg;
}

function copyEnv() {
  const copied = [];
  for (const n of readdirSync(BACKEND)) {
    // .env.local is emulator-only by Firebase's rules; never ship it.
    if (!/^\.env(\.[A-Za-z0-9_-]+)?$/.test(n) || n === '.env.local' || n === '.env.example') continue;
    copyFileSync(join(BACKEND, n), join(OUT, n));
    copied.push(n);
  }
  return copied;
}

const GUARD = /deploy-guard\.mjs/;

/**
 * The Hosting site id behind each target of firebase.json, for a project.
 * The usercontent site is a SECOND site in the same project and must be
 * created once by hand (see docs/plan/artifacts.html §D1):
 *   firebase hosting:sites:create {project}-usercontent --project {project}
 * backend/src/artifacts/capability.ts derives the same name for the URLs it
 * hands out (TM_ARTIFACT_ORIGIN overrides both halves together).
 */
export function hostingSites(project) {
  return { app: project, usercontent: `${project}-usercontent` };
}

/** firebase.json → firebase.deploy.json for `firebase deploy --config`. */
export function writeDeployConfig(project) {
  const cfg = readJson(join(ROOT, 'firebase.json'));
  const region = regionFor(project);
  delete cfg.emulators;
  const strip = (block) => {
    if (block?.predeploy) {
      const hooks = [].concat(block.predeploy).filter((h) => !GUARD.test(h));
      if (hooks.length) block.predeploy = hooks;
      else delete block.predeploy;
    }
  };
  const sites = hostingSites(project);
  cfg.hosting = [].concat(cfg.hosting ?? []).map((site) => {
    const h = { ...site };
    strip(h);
    for (const r of h.rewrites ?? []) if (r.function) r.function.region = region;
    if (h.target) {
      const id = sites[h.target];
      if (!id) throw new Error(`firebase.json hosting target "${h.target}" has no site (hostingSites)`);
      // `site` first, in place of `target` — the rest of the entry is untouched.
      const { target: _target, ...rest } = h;
      return { site: id, ...rest };
    }
    return h;
  });
  cfg.functions = [].concat(cfg.functions ?? []).map((f) => {
    const g = { ...f };
    strip(g);
    if (g.source === 'backend' || g.codebase === 'default') {
      g.source = relative(ROOT, OUT);
      g.ignore = ['node_modules', '.git', '*.log', 'firebase-debug.log', '*.map'];
    }
    return g;
  });
  writeFileSync(
    DEPLOY_CONFIG,
    JSON.stringify(
      { $comment: 'GENERATED by scripts/deploy-functions.mjs from firebase.json — do not edit', ...cfg },
      null,
      2,
    ) + '\n',
  );
  return { region, sites };
}

/** Simulate Cloud Build: clean install of the generated package, then load it. */
export function verify(project = DEFAULT_PROJECT) {
  log('verify: npm install --omit=dev (as Cloud Build does)');
  rmSync(join(OUT, 'node_modules'), { recursive: true, force: true });
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], OUT);

  // Load in a clean env that looks like the deployed runtime (not the emulators).
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/_EMULATOR_HOST$|^FUNCTIONS_EMULATOR$|^TM_|^FIREBASE_CONFIG$|^GCLOUD_PROJECT$/.test(k),
    ),
  );
  Object.assign(env, readDotenv(join(OUT, '.env')), readDotenv(join(OUT, `.env.${project}`)), {
    GCLOUD_PROJECT: project,
    NODE_PATH: '',
  });
  const probe = (entry) => {
    const code = `
      const m = require(${JSON.stringify(entry)});
      const names = Object.keys(m).filter((k) => m[k] !== undefined).sort();
      console.log(JSON.stringify(names));`;
    // require(): the Functions runtime loads the entry the same way (Node 22 require(esm)).
    const r = spawnSync(process.execPath, ['-e', code], { cwd: OUT, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`loading ${entry} failed:\n${r.stderr}`);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  const bundled = probe(join(OUT, 'lib', 'index.js'));
  log(`verify: bundle exports ${bundled.length} functions: ${bundled.join(', ')}`);
  const reference = probe(join(LIB, 'index.js'));
  const missing = reference.filter((n) => !bundled.includes(n));
  const extra = bundled.filter((n) => !reference.includes(n));
  if (missing.length || extra.length)
    throw new Error(
      `bundle exports differ from backend/lib — missing: [${missing}] extra: [${extra}]`,
    );
  // Nothing may reach outside backend/deploy: the dependency tree must be self-contained.
  const leak = readFileSync(join(OUT, 'lib', 'index.js'), 'utf8').match(/from ["']@tm\/[^"']+["']/);
  if (leak) throw new Error(`bundle still imports ${leak[0]}`);
  log('verify: OK — identical function surface to backend/lib');
  return bundled;
}

async function main() {
  const project = opt('--project') ?? process.env.TM_DEPLOY_PROJECT ?? DEFAULT_PROJECT;
  if (!flag('--skip-build')) {
    log('building @tm/shared + @tm/backend (tsc)');
    run('pnpm', ['--filter', '@tm/backend', 'build']);
  }
  if (!existsSync(join(LIB, 'index.js'))) throw new Error('backend/lib/index.js missing — build first');

  // Keep a previous node_modules / lockfile only if --verify will refresh it anyway.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'lib'), { recursive: true });

  const externals = await bundle(project);
  const pkg = writePackageJson(externals);
  const env = copyEnv();
  const { region, sites } = writeDeployConfig(project);
  log(`bundled → ${relative(ROOT, OUT)}/lib/index.js (@tm/shared inlined)`);
  log(`dependencies: ${Object.entries(pkg.dependencies).map(([n, v]) => `${n}@${v}`).join(', ')}`);
  log(`env files: ${env.join(', ') || '(none)'} · region ${region} · config ${relative(ROOT, DEPLOY_CONFIG)}`);
  log(`hosting sites: ${Object.entries(sites).map(([t, s]) => `${t} → ${s}`).join(', ')}`);
  if (!existsSync(join(BACKEND, `.env.${project}`)))
    log(`\x1b[33mwarning\x1b[0m: backend/.env.${project} not found — functions default to us-central1`);

  if (flag('--verify')) verify(project);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`\x1b[31mfunctions\x1b[0m │ ${e.message}`);
    process.exit(1);
  });
}


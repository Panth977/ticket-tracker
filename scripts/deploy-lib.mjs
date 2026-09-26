#!/usr/bin/env node
/**
 * Stage the hosted SDK into the hosting build — `/lib/**` (agents.html §M).
 *
 *   frontend/build/lib/index.html      the install page (frontend/static/lib/, copied by vite)
 *   frontend/build/lib/v1/…            the PINNED artefacts: immutable, cached for a year
 *   frontend/build/lib/latest/…        the same files, never cached
 *
 * Each of v1/ and latest/ gets:
 *
 *   sdk.js  sdk.min.js       ESM bundles (browsers, Deno, Bun)
 *   sdk.ts                   the whole SDK as one TypeScript file (Deno/Bun type it natively)
 *   sdk.d.ts                 one flat declaration file
 *   tm-sdk-<version>.tgz     the npm tarball, pinned …
 *   tm-sdk.tgz               … and under its moving name
 *   openapi.json             a copy of /v1/openapi.json, generated from the SAME zod
 *                            schemas the routes parse with (backend/lib/platform/openapi.js)
 *   sdk.json                 what this build is: version, sizes, sha-256 of every file
 *
 * WHY THE SAME BYTES TWICE. `/lib/v1/*` is what a consumer pins: it is cached
 * `immutable` for a year, so it must never change under them — a new SDK gets a
 * new tarball name and, when the wire format changes, a new prefix (/lib/v2/).
 * `/lib/latest/*` is the moving target for "give me whatever is newest", so
 * hosting sends `no-store` for it (headers live in firebase.json).
 *
 * WHY THIS REFUSES A STALE dist/. The artefacts are built by sdk/build.mjs, not
 * here — a deploy that silently shipped yesterday's bundle next to today's API
 * is the exact failure this plumbing exists to prevent. So: every file must
 * exist, carry the version sdk/package.json claims, and be NEWER than every
 * source it is built from. Otherwise the deploy stops and says what to run.
 *
 *   node scripts/deploy-lib.mjs [--project <id>] [--out <dir>] [--build] [--quiet]
 *
 *   --build       run `pnpm sdk:build` first instead of failing on a stale dist/
 *   --stale-ok    skip the freshness check (a fresh checkout has odd mtimes)
 *   --out <dir>   stage somewhere other than frontend/build
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROJECT, PLACEHOLDER_PROJECT, isPlaceholder } from './project.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SDK = join(ROOT, 'sdk');
const DIST = join(SDK, 'dist');
export { DEFAULT_PROJECT };

/** The two prefixes §M hosts. `v1` is the wire version, not the package version. */
export const CHANNELS = ['v1', 'latest'];

/** Everything sdk/build.mjs produces that §M puts on the web. */
const ARTEFACTS = (version) => [
  'sdk.js',
  'sdk.min.js',
  'sdk.ts',
  'sdk.d.ts',
  `tm-sdk-${version}.tgz`,
  'tm-sdk.tgz',
];

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : dflt;
};
const quiet = flag('--quiet');
const log = (m) => quiet || console.log(`\x1b[35mlib\x1b[0m │ ${m}`);

class LibError extends Error {}
const fail = (m) => {
  throw new LibError(m);
};

/** Newest mtime under a directory (files only), or 0 if it does not exist. */
async function newestUnder(dir) {
  let newest = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? await newestUnder(p) : statSync(p).mtimeMs);
  }
  return newest;
}

/**
 * The artefacts must exist, be stamped with the version sdk/package.json
 * claims, and be newer than every source they come from.
 */
async function checkDist(version, staleOk) {
  const files = ARTEFACTS(version);
  const missing = files.filter((f) => !existsSync(join(DIST, f)));
  if (missing.length)
    fail(
      `sdk/dist is missing ${missing.join(', ')}\n` +
        '    the hosted SDK is built by sdk/build.mjs, not by the deploy — run:  pnpm sdk:build',
    );

  // The bundles carry `//! @tm/sdk <version>`; the tarball name carries it too.
  for (const f of ['sdk.js', 'sdk.min.js']) {
    const text = await readFile(join(DIST, f), 'utf8');
    if (!text.startsWith('/// <reference types="./sdk.d.ts" />'))
      fail(`sdk/dist/${f} does not start with the triple-slash reference — Deno and Bun read it for types`);
    if (!text.includes(`@tm/sdk ${version}`))
      fail(`sdk/dist/${f} is not stamped @tm/sdk ${version} — rebuild:  pnpm sdk:build`);
  }
  // A declaration file that still imports @tm/shared cannot be typed from a URL.
  const dts = await readFile(join(DIST, 'sdk.d.ts'), 'utf8');
  if (/^\s*import\s/m.test(dts)) fail('sdk/dist/sdk.d.ts has an import statement — it must be flat (rebuild the SDK)');

  if (staleOk) return files;

  // Freshness: every source that feeds sdk/build.mjs.
  const sources = [
    await newestUnder(join(SDK, 'src')),
    statSync(join(SDK, 'build.mjs')).mtimeMs,
    statSync(join(SDK, 'package.json')).mtimeMs,
    existsSync(join(SDK, 'README.md')) ? statSync(join(SDK, 'README.md')).mtimeMs : 0,
  ];
  const newestSource = Math.max(...sources);
  const oldest = files.reduce(
    (acc, f) => {
      const ms = statSync(join(DIST, f)).mtimeMs;
      return ms < acc.ms ? { ms, f } : acc;
    },
    { ms: Infinity, f: '' },
  );
  if (oldest.ms < newestSource)
    fail(
      `sdk/dist is stale — ${oldest.f} is older than sdk/src (or build.mjs/package.json)\n` +
        `    built ${new Date(oldest.ms).toISOString()}, sources changed ${new Date(newestSource).toISOString()}\n` +
        '    run:  pnpm sdk:build     (or pass --stale-ok if the mtimes are lying, e.g. a fresh checkout)',
    );
  return files;
}

/**
 * /v1/openapi.json without a server running: the document is a pure function of
 * the zod schemas, and `API_URL` is the only thing it takes from the request.
 * Generated in a child process so importing the backend cannot leave anything
 * behind in this one.
 */
function openApiJson(project) {
  const lib = join(ROOT, 'backend', 'lib', 'platform', 'openapi.js');
  if (!existsSync(lib))
    fail(
      'backend/lib/platform/openapi.js is missing — the API description is generated from the built backend\n' +
        '    run:  pnpm --filter @tm/backend build',
    );
  const code = `
    const { openApiDocument } = await import(${JSON.stringify(lib)});
    // API_URL decides the \`servers\` entry; nothing else on the context is read.
    const doc = openApiDocument({ req: { url: process.env.API_URL + '/v1/openapi.json', header: () => undefined } });
    process.stdout.write(JSON.stringify(doc, null, 2) + '\\n');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, API_URL: `https://${project}.web.app` },
  });
  if (r.status !== 0) fail(`generating openapi.json failed:\n${r.stderr || r.stdout}`);
  const doc = JSON.parse(r.stdout);
  const paths = Object.keys(doc.paths ?? {}).length;
  if (!paths) fail('the generated openapi.json has no paths');
  return { json: r.stdout, paths };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Rewrite the placeholder host in the text artefacts just staged to this
 * project's. The tarball is binary and keeps the placeholder as its DEFAULT
 * base URL — npm users pass `baseUrl`, as the README says.
 */
async function rehost(dir, names, project) {
  if (isPlaceholder(project)) return;
  const from = `https://${PLACEHOLDER_PROJECT}.web.app`;
  const to = `https://${project}.web.app`;
  for (const f of names) {
    if (/\.(tgz|zip|png)$/.test(f) || !existsSync(join(dir, f))) continue;
    const text = await readFile(join(dir, f), 'utf8');
    if (text.includes(from)) await writeFile(join(dir, f), text.replaceAll(from, to));
  }
}

export async function stageLib({
  project = DEFAULT_PROJECT,
  out = join(ROOT, 'frontend', 'build'),
  build = flag('--build'),
  staleOk = flag('--stale-ok'),
} = {}) {
  const pkg = JSON.parse(await readFile(join(SDK, 'package.json'), 'utf8'));
  const { version } = pkg;

  if (build) {
    log('pnpm sdk:build');
    const r = spawnSync('pnpm', ['sdk:build'], { cwd: ROOT, stdio: quiet ? 'pipe' : 'inherit' });
    if (r.status !== 0) fail('pnpm sdk:build failed');
  }

  const files = await checkDist(version, staleOk);
  log(`@tm/sdk ${version} — ${files.length} artefacts, fresh`);

  const { json: openapi, paths } = openApiJson(project);
  log(`openapi.json — ${paths} paths, servers: https://${project}.web.app`);

  if (!existsSync(out))
    fail(`${relative(ROOT, out)} does not exist — build the SPA first (pnpm --filter @tm/frontend build)`);
  // The install page is a static asset of the SPA; if it is missing the build
  // did not come from this repo's frontend/static/lib/.
  if (!existsSync(join(out, 'lib', 'index.html')))
    fail(`${relative(ROOT, out)}/lib/index.html is missing — frontend/static/lib/index.html should have been copied by the SPA build`);

  const manifest = {
    version,
    package: pkg.name,
    generated: new Date().toISOString(),
    channels: CHANNELS,
    files: {},
  };

  for (const channel of CHANNELS) {
    const dir = join(out, 'lib', channel);
    // Wipe first: a file that vanished from dist/ must not survive in the build.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    for (const f of files) await copyFile(join(DIST, f), join(dir, f));
    await writeFile(join(dir, 'openapi.json'), openapi);
    // The committed sources name the placeholder project; what ships names this one.
    await rehost(dir, files, project);
  }
  await rehost(join(out, 'lib'), ['index.html'], project);

  // One manifest, identical in both channels, describing the bytes just staged.
  for (const f of [...files, 'openapi.json']) {
    const buf = await readFile(join(out, 'lib', 'v1', f));
    manifest.files[f] = { bytes: buf.length, sha256: sha256(buf) };
  }
  for (const channel of CHANNELS)
    await writeFile(
      join(out, 'lib', channel, 'sdk.json'),
      JSON.stringify({ ...manifest, channel, base: `/lib/${channel}/` }, null, 2) + '\n',
    );

  const total = Object.values(manifest.files).reduce((n, f) => n + f.bytes, 0);
  log(
    `staged → ${relative(ROOT, out)}/lib/{${CHANNELS.join(',')}}/  ` +
      `${Object.keys(manifest.files).length + 1} files, ${(total / 1024).toFixed(0)} kB each`,
  );
  return { version, out: join(out, 'lib'), manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const project = opt('--project') ?? process.env.TM_DEPLOY_PROJECT ?? DEFAULT_PROJECT;
  const out = opt('--out') ? join(ROOT, opt('--out')) : join(ROOT, 'frontend', 'build');
  try {
    await stageLib({ project, out });
  } catch (e) {
    console.error(`\n\x1b[31mlib\x1b[0m │ ${e instanceof LibError ? e.message : (e?.stack ?? e)}\n`);
    process.exit(1);
  }
}

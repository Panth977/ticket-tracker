/**
 * The integration context an orchestrator is pointed at (docs/plan/agents.html §O).
 *
 * Four files are published beside the app — /llms.txt, /llms-full.txt,
 * /integrate and /integrate.json — and every one of them is GENERATED from the
 * software itself. Two things can go wrong with that, and this suite is about
 * both:
 *
 *   1. They are not actually served, or are served as the wrong thing. A model
 *      handed `text/html` where it expected Markdown, or a cached copy of a
 *      page whose whole purpose is to answer "has this changed?", is worse off
 *      than with no page at all.
 *   2. They drift. A route added to REST_ROUTES or a tool added to MCP_TOOLS
 *      that never reaches /llms-full.txt is exactly the rot the generator
 *      exists to prevent — so the guard that stops a stale copy is tested too,
 *      by tampering with a copy and watching it be caught.
 *
 * The dev stack is vite (no hosting emulator), so the HEADERS hosting adds —
 * no-store, the explicit charset, CORS — are asserted here against
 * firebase.json, the config that produces them, and proven live against the
 * real hosting emulator by scripts/deploy-lib-check.mjs.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  AGENT_EVENT_TYPES,
  APP_ERROR_CODES,
  MCP_TOOLS,
  REST_ROUTES,
  SCOPE_PRESET_LABELS,
  TOKEN_SCOPES,
} from '@tm/shared';
// @ts-expect-error — plain .mjs shared with the root scripts
import { BINARIES, check, generate, OUTPUTS } from '../../../scripts/gen-integration.mjs';

const ROOT = new URL('../../../', import.meta.url).pathname;

/** What each published URL must answer with. */
const SERVED = [
  { path: '/llms.txt', type: 'text/plain', contains: '# TaskManager' },
  { path: '/llms-full.txt', type: 'text/plain', contains: '# TaskManager — integration context' },
  { path: '/integrate.json', type: 'application/json', contains: '"apiBase"' },
  { path: '/integrate/index.html', type: 'text/html', contains: 'Integrate TaskManager' },
] as const;

test('every integration URL is served, with the right content type', async ({ request }) => {
  for (const { path, type, contains } of SERVED) {
    const res = await request.get(path);
    expect(res.status(), `${path} should be served`).toBe(200);
    expect(res.headers()['content-type'], `${path} content-type`).toContain(type);
    expect(await res.text(), `${path} body`).toContain(contains);
  }
});

test('llms-full.txt documents every REST path and every MCP tool', async ({ request }) => {
  const text = await (await request.get('/llms-full.txt')).text();

  // Every route the server is built from, with its method — not just the path,
  // so a POST documented only as a GET is still a failure.
  const missingRoutes = REST_ROUTES.filter((r) => !text.includes(`#### ${r.method} ${r.path}`));
  expect(missingRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([]);

  // Every MCP tool, with its own heading and its description.
  const missingTools = Object.entries(MCP_TOOLS).filter(
    ([name, meta]) => !text.includes(`#### ${name}`) || !text.includes(meta.description),
  );
  expect(missingTools.map(([n]) => n)).toEqual([]);

  // And the contracts an agent has to reason about.
  for (const scope of TOKEN_SCOPES) expect(text, `scope ${scope}`).toContain(scope);
  for (const type of AGENT_EVENT_TYPES) expect(text, `event ${type}`).toContain(type);
  for (const code of APP_ERROR_CODES) expect(text, `error ${code}`).toContain(code);
  for (const label of Object.values(SCOPE_PRESET_LABELS))
    expect(text, `preset ${label}`).toContain(label);

  // The prose that makes it usable, not just a schema dump.
  for (const needle of [
    'Authorization: Bearer',
    'Idempotency-Key',
    '## 4. The loop',
    'tm.work(',
    'const BASE =', // the raw-REST variant of the same loop
    '## 6. Rules of the house',
    '## 7. Recipes',
    '## 8. Version and changelog',
  ])
    expect(text, `llms-full.txt should contain ${needle}`).toContain(needle);
});

test('integrate.json is a manifest a machine can bootstrap from', async ({ request }) => {
  const m = await (await request.get('/integrate.json')).json();
  const sdkVersion = JSON.parse(await readFile(join(ROOT, 'sdk', 'package.json'), 'utf8')).version;

  expect(m.version).toBe(sdkVersion);
  expect(m.apiVersion).toBe('v1');
  for (const url of [
    m.apiBase,
    m.mcpUrl,
    m.openapiUrl,
    m.llmsUrl,
    m.llmsFullUrl,
    m.integrateUrl,
    m.sdk.esm,
    m.sdk.types,
  ])
    expect(String(url)).toMatch(/^https:\/\//);
  expect(m.apiBase).toMatch(/\/v1$/);
  expect(m.mcpUrl).toMatch(/\/mcp$/);

  expect(m.scopes.map((s: { name: string }) => s.name)).toEqual([...TOKEN_SCOPES]);
  expect(m.events.map((e: { type: string }) => e.type)).toEqual([...AGENT_EVENT_TYPES]);
  expect(m.rest).toHaveLength(REST_ROUTES.length);
  expect(m.mcpTools.map((t: { name: string }) => t.name)).toEqual(Object.keys(MCP_TOOLS));
  expect(m.errorCodes.map((e: { code: string }) => e.code)).toEqual([...APP_ERROR_CODES]);
  expect(m.auth.tokenPrefix).toBe('tm_live_');

  // The sha an agent compares against the copy it is holding.
  const full = await (await request.get('/llms-full.txt')).text();
  expect(full, 'the manifest sha must be the one stamped into the page').toContain(m.contentSha256);
});

test('the published copy matches a fresh generation, and a stale one fails the guard', async () => {
  // What is committed under frontend/static must be what the generator makes
  // today — this is the check the deploy runs.
  const fresh = await check({});
  expect(
    fresh.stale.map((f: { path: string }) => f.path),
    'run: pnpm integrate:gen',
  ).toEqual([]);

  // And the guard must actually catch a stale file: generate into a temp
  // directory, tamper with one byte of each file in turn, and watch it fail.
  const dir = await mkdtemp(join(tmpdir(), 'tm-integrate-'));
  const res = await generate({});
  // Text AND binaries — the Claude plugin's zip (§R3) is generated here too, and
  // a directory missing it is a directory the guard must call stale.
  for (const [name, text] of Object.entries({ ...res.files, ...res.binaries } as Record<
    string,
    string | Buffer
  >)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  expect((await check({ dir })).stale).toEqual([]);

  for (const name of OUTPUTS as string[]) {
    const p = join(dir, name);
    const original = await readFile(p, 'utf8');
    await writeFile(p, original + '\nstale\n');
    const stale = await check({ dir });
    expect(
      stale.stale.map((f: { name: string }) => f.name),
      `a tampered ${name} must fail the guard`,
    ).toEqual([name]);
    await writeFile(p, original);
  }

  // The zip is compared as bytes, so one flipped byte in the middle of it — a
  // change no text comparison would survive either — has to be caught.
  for (const name of BINARIES as string[]) {
    const p = join(dir, name);
    const original = await readFile(p);
    const tampered = Buffer.from(original);
    // writeUInt8, not `tampered[i] ^= 0xff`: noUncheckedIndexedAccess types an
    // index read as possibly undefined.
    const at = Math.floor(tampered.length / 2);
    tampered.writeUInt8(tampered.readUInt8(at) ^ 0xff, at);
    await writeFile(p, tampered);
    const stale = await check({ dir });
    expect(
      stale.stale.map((f: { name: string }) => f.name),
      `a tampered ${name} must fail the guard`,
    ).toEqual([name]);
    await writeFile(p, original);
  }
});

test('hosting is configured to serve them as plain text, uncached and cross-origin', async () => {
  // The dev stack has no hosting emulator, so this asserts the CONFIG that
  // produces the headers; scripts/deploy-lib-check.mjs proves them live.
  type Rule = { source: string; headers: { key: string; value: string }[] };
  const cfg = JSON.parse(await readFile(join(ROOT, 'firebase.json'), 'utf8')) as {
    hosting: { headers?: Rule[] } | { headers?: Rule[] }[];
  };
  const sites = Array.isArray(cfg.hosting) ? cfg.hosting : [cfg.hosting];
  const headers: Rule[] = sites.flatMap((h) => h.headers ?? []);
  const rule = (source: string) => {
    const r = headers.find((h) => h.source === source);
    expect(r, `firebase.json should have a headers rule for ${source}`).toBeTruthy();
    return Object.fromEntries(r!.headers.map((h) => [h.key.toLowerCase(), h.value]));
  };

  const txt = rule('/llms*.txt');
  expect(txt['content-type']).toBe('text/plain; charset=utf-8');
  expect(txt['cache-control']).toBe('no-store');
  expect(txt['access-control-allow-origin']).toBe('*');

  const manifest = rule('/integrate.json');
  expect(manifest['content-type']).toBe('application/json; charset=utf-8');
  expect(manifest['cache-control']).toBe('no-store');
  expect(manifest['access-control-allow-origin']).toBe('*');

  // A header rule matches the REQUEST path, so the readable page needs all
  // three spellings — the one people type, the normalised directory, the file.
  for (const source of ['/integrate', '/integrate/', '/integrate/index.html']) {
    const page = rule(source);
    expect(page['cache-control'], source).toBe('no-cache');
    expect(page['access-control-allow-origin'], source).toBe('*');
  }
});

test('the /lib index, the app and the docs all point at it', async ({ request }) => {
  const lib = await (await request.get('/lib/index.html')).text();
  expect(lib).toContain('/llms-full.txt');
  expect(lib).toContain('/integrate');

  // The Tokens screen's "for your agent" line lives in the SPA source; the
  // built page is a bundle, so assert the source carries it.
  const tokens = await readFile(
    join(ROOT, 'frontend', 'src', 'lib', 'account', 'sections', 'TokensSection.svelte'),
    'utf8',
  );
  expect(tokens).toContain('/llms-full.txt');
  expect(tokens).toContain('For your agent');

  const sdkDoc = await readFile(join(ROOT, 'docs', 'plan', 'sdk.html'), 'utf8');
  expect(sdkDoc).toContain('/llms-full.txt');
  expect(sdkDoc).toContain('/integrate.json');
});

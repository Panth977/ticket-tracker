#!/usr/bin/env node
/**
 * THE ONE PAGE an orchestrator is pointed at (docs/plan/agents.html §O).
 *
 * An agent joining this ecosystem should need one URL, not a tour of the docs
 * site. So the app publishes its own integration context — and publishes it
 * GENERATED, from the same sources the software runs on, so there is no second
 * copy to rot:
 *
 *   frontend/static/llms.txt            the short index: what this is, the URLs, how to authenticate
 *   frontend/static/llms-full.txt       THE ONE PAGE — the whole operating context, Markdown
 *   frontend/static/integrate/index.html  the same content as a readable page (plain static HTML)
 *   frontend/static/integrate.json      a machine manifest: api, mcp, sdk, openapi, llms URLs + version
 *
 * And, for a PERSON putting this inside Claude (docs/plan/agents.html §R3):
 *
 *   frontend/static/integrate/claude/index.html  the setup guide: connector, `claude mcp add`, plugin
 *   frontend/static/lib/claude-plugin/**         the Claude Code plugin, unpacked and browsable
 *   frontend/static/lib/claude-plugin.zip        the same bundle as one download
 *
 * The plugin is generated here rather than hand-kept because its SKILL is the
 * §O context: a hand-written copy would be a second copy, and the whole point
 * of this script is that there is never a second copy. The skill even ships
 * llms-full.txt verbatim as its reference file.
 *
 * WHERE EACH PART COMES FROM
 *   prose        scripts/integration-source/*.md — the only hand-written part.
 *                A `{{gen:name}}` marker in there is replaced by a generated block.
 *                integrate-claude.md is the §R3 guide (named so it is not read
 *                as a CLAUDE.md), and claude-plugin/** holds the plugin's own
 *                files, which carry the same markers.
 *   REST         /v1/openapi.json, generated from the zod schemas the routes
 *                parse with (backend/lib/platform/openapi.js) — every endpoint,
 *                its parameters, body and responses.
 *   MCP          the tool registry in @tm/shared (MCP_TOOLS + McpToolShapes):
 *                names, descriptions, scopes and input schemas.
 *   contracts    @tm/shared: scopes, event types, error codes, field types and
 *                the states a ticket, a question and a task-list item can be in.
 *   SDK          sdk/dist/sdk.d.ts — the client surface, verbatim, with its doc
 *                comments, so a signature here is the signature that compiles.
 *
 * DETERMINISTIC ON PURPOSE. The deploy fails when the committed copy differs
 * from a fresh generation (`--check`, the same guard style as the SDK
 * artefacts), so the same inputs must produce the same bytes — every list is
 * emitted in a fixed order and nothing reads the clock. The "updated" stamp is
 * therefore the date of the newest entry in the CHANGELOG (which an author
 * bumps when the contract moves), not `new Date()`: a wall-clock stamp would
 * make the guard fail every midnight for no reason at all.
 *
 *   node scripts/gen-integration.mjs              write every published file
 *   node scripts/gen-integration.mjs --check      fail if the committed copy is stale
 *   node scripts/gen-integration.mjs --out <dir>  write somewhere else (a temp dir, a build)
 *   node scripts/gen-integration.mjs --project <id>   another Firebase project's URLs
 *   node scripts/gen-integration.mjs --quiet
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLACEHOLDER_PROJECT } from './project.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'scripts', 'integration-source');
const STATIC = join(ROOT, 'frontend', 'static');
const DEFAULT_PROJECT = PLACEHOLDER_PROJECT;
export { DEFAULT_PROJECT };

/**
 * The Claude plugin bundle (docs/plan/agents.html §R3), relative to PLUGIN_DIR.
 * Every one of these is generated from the same inputs as the page, so the
 * skill an installed plugin carries can never describe a different API than
 * the one the MCP server it wires up actually serves.
 */
export const PLUGIN_FILES = [
  join('.claude-plugin', 'plugin.json'),
  join('.claude-plugin', 'marketplace.json'),
  'README.md',
  join('commands', 'tm-inbox.md'),
  join('commands', 'tm-triage.md'),
  join('commands', 'tm-new.md'),
  join('commands', 'tm-ticket.md'),
  join('commands', 'tm-standup.md'),
  join('skills', 'taskmanager', 'SKILL.md'),
  join('skills', 'taskmanager', 'reference', 'llms-full.txt'),
];
export const PLUGIN_DIR = join('lib', 'claude-plugin');
/** The same bundle as one download. Binary, so the guard compares it byte for byte. */
export const PLUGIN_ZIP = join('lib', 'claude-plugin.zip');
/** The name of the folder INSIDE the zip — unzipping leaves you a plugin directory. */
export const PLUGIN_NAME = 'claude-plugin';

/** The text files, relative to the output directory (frontend/static by default). */
export const OUTPUTS = [
  'llms.txt',
  'llms-full.txt',
  'integrate.json',
  join('integrate', 'index.html'),
  join('integrate', 'claude', 'index.html'),
  ...PLUGIN_FILES.map((f) => join(PLUGIN_DIR, f)),
];
/** The binary files, compared byte for byte rather than as text. */
export const BINARIES = [PLUGIN_ZIP];

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : dflt;
};
const quiet = flag('--quiet');
const log = (m) => quiet || console.log(`\x1b[36mintegrate\x1b[0m │ ${m}`);

export class IntegrationError extends Error {}
const fail = (m) => {
  throw new IntegrationError(m);
};

// ───────────────────────────────────────────────────────────── inputs

/**
 * /v1/openapi.json without a server running: the document is a pure function
 * of the zod schemas, and API_URL is the only thing it takes from the request.
 * Generated in a child process so importing the backend cannot leave anything
 * behind in this one (the same trick scripts/deploy-lib.mjs uses).
 */
function openApiDoc(project) {
  const lib = join(ROOT, 'backend', 'lib', 'platform', 'openapi.js');
  if (!existsSync(lib))
    fail(
      'backend/lib/platform/openapi.js is missing — the REST reference is generated from the built backend\n' +
        '    run:  pnpm --filter @tm/backend build',
    );
  const code = `
    const { openApiDocument } = await import(${JSON.stringify(pathToFileURL(lib).href)});
    const doc = openApiDocument({ req: { url: process.env.API_URL + '/v1/openapi.json', header: () => undefined } });
    process.stdout.write(JSON.stringify(doc));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, API_URL: `https://${project}.web.app` },
  });
  if (r.status !== 0) fail(`generating the OpenAPI document failed:\n${r.stderr || r.stdout}`);
  const doc = JSON.parse(r.stdout);
  if (!Object.keys(doc.paths ?? {}).length) fail('the generated OpenAPI document has no paths');
  return doc;
}

/** The shared contracts, from the BUILT package — the same module the backend imports. */
async function loadShared() {
  const entry = join(ROOT, 'shared', 'dist', 'index.js');
  if (!existsSync(entry))
    fail('shared/dist is missing — the contracts are read from the built package\n    run:  pnpm --filter @tm/shared build');
  return import(pathToFileURL(entry).href);
}

function loadSdk() {
  const dts = join(ROOT, 'sdk', 'dist', 'sdk.d.ts');
  if (!existsSync(dts))
    fail('sdk/dist/sdk.d.ts is missing — the SDK reference is read from the declaration file\n    run:  pnpm sdk:build');
  return {
    dts: readFileSync(dts, 'utf8'),
    version: JSON.parse(readFileSync(join(ROOT, 'sdk', 'package.json'), 'utf8')).version,
  };
}

/** Every prose file, by name. `index.md` feeds llms.txt; the numbered ones feed llms-full.txt. */
async function loadProse() {
  let names;
  try {
    names = (await readdir(SOURCE)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    fail(`${relative(ROOT, SOURCE)} is missing — the prose for the page lives there`);
  }
  const out = {};
  for (const n of names) out[n] = await readFile(join(SOURCE, n), 'utf8');
  if (!out['index.md']) fail(`${relative(ROOT, SOURCE)}/index.md is missing (the short llms.txt orientation)`);
  return out;
}

/**
 * The changelog is the version record AND the date stamp (see the header note).
 * Entries are `### <version> — <YYYY-MM-DD>`, newest first.
 */
function parseChangelog(md, sdkVersion) {
  const entries = [...md.matchAll(/^###\s+(\S+)\s+[—-]\s+(\d{4}-\d{2}-\d{2})\s*$/gm)].map((m) => ({
    version: m[1],
    date: m[2],
  }));
  if (!entries.length) fail('the changelog has no `### <version> — <YYYY-MM-DD>` entries');
  if (entries[0].version !== sdkVersion)
    fail(
      `the changelog's newest entry is ${entries[0].version}, but @tm/sdk is ${sdkVersion}\n` +
        `    add a '### ${sdkVersion} — <date>' entry to scripts/integration-source/90-changelog.md`,
    );
  return entries;
}

// ─────────────────────────────────────────────────── rendering helpers

const pad = (s, n) => String(s).padEnd(n);
/** A fenced block, always with a language so the HTML page can label it. */
const fence = (lang, body) => '```' + lang + '\n' + body.replace(/\s+$/, '') + '\n```';

/**
 * Lay out rows as aligned, fixed-width columns — readable in a terminal and in
 * a model's context. A column's width is capped (MAX_COL) so that one outlier
 * value overflows its own line rather than pushing every other row sideways.
 */
const MAX_COL = 34;
function columns(rows) {
  if (!rows.length) return '';
  const widths = rows[0].map((_, i) =>
    Math.min(MAX_COL, Math.max(...rows.map((r) => String(r[i] ?? '').length))),
  );
  return rows
    .map((r) => r.map((c, i) => (i === r.length - 1 ? String(c ?? '') : pad(c ?? '', widths[i]))).join('  ').replace(/\s+$/, ''))
    .join('\n');
}

/** A union longer than this is unreadable in a column; the full list is in §5.1. */
function clampUnion(parts) {
  const full = parts.join(' | ');
  if (full.length <= 64 || parts.length <= 4) return full;
  return `${parts.slice(0, 3).join(' | ')} | … (${parts.length} values)`;
}

// ── JSON Schema → a one-line type, and an object → field lines

/**
 * A `$ref`. `#/components/schemas/X` is a named schema — print the name. Anything
 * else is an INTERNAL pointer (zod-to-json-schema emits `#/properties/board/anyOf/0`
 * when two fields share a shape); resolve it against the schema it came from,
 * or nothing readable comes out.
 */
function resolveRef(ref, components, root) {
  const named = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (named) return { name: named[1], schema: components[named[1]] };
  if (!ref.startsWith('#/')) return { name: null, schema: null };
  let cur = root;
  for (const seg of ref.slice(2).split('/')) {
    cur = cur?.[decodeURIComponent(seg).replace(/~1/g, '/').replace(/~0/g, '~')];
    if (cur === undefined) return { name: null, schema: null };
  }
  return { name: null, schema: cur };
}

function jsonType(s, components, depth = 0, root = s) {
  if (!s) return 'any';
  if (s.$ref) {
    const r = resolveRef(s.$ref, components, root);
    if (r.name) return r.name;
    return r.schema ? jsonType(r.schema, components, depth, root) : 'object';
  }
  if (s.enum) return clampUnion(s.enum.map((v) => JSON.stringify(v)));
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.anyOf || s.oneOf) {
    const parts = (s.anyOf ?? s.oneOf).map((x) => jsonType(x, components, depth + 1, root));
    return clampUnion([...new Set(parts)]);
  }
  if (s.allOf) return s.allOf.map((x) => jsonType(x, components, depth + 1, root)).join(' & ');
  const t = Array.isArray(s.type) ? s.type.join(' | ') : s.type;
  if (t === 'array') return `${jsonType(s.items, components, depth + 1, root)}[]`;
  if (t === 'object' || (!t && s.properties)) {
    if (depth >= 1) return 'object';
    const keys = Object.keys(s.properties ?? {});
    if (!keys.length) return 'object';
    return `{ ${keys.join(', ')} }`;
  }
  return t ?? 'any';
}

const deref = (s, components) => (s?.$ref ? resolveRef(s.$ref, components, s).schema : s);

/** `name  type  required  description` for every property of an object schema. */
function fieldLines(schema, components) {
  const s = deref(schema, components);
  if (!s) return [];
  if (!s.properties) return [['(value)', jsonType(s, components, 0, s), '', s.description ?? '']];
  const required = new Set(s.required ?? []);
  return Object.entries(s.properties).map(([name, prop]) => {
    const p = prop;
    const notes = [];
    if (p.default !== undefined) notes.push(`default ${JSON.stringify(p.default)}`);
    if (p.minimum !== undefined || p.maximum !== undefined) notes.push(`${p.minimum ?? ''}…${p.maximum ?? ''}`);
    if (p.maxLength !== undefined) notes.push(`≤ ${p.maxLength} chars`);
    if (p.maxItems !== undefined) notes.push(`≤ ${p.maxItems} items`);
    const desc = [p.description, notes.length ? `(${notes.join(', ')})` : ''].filter(Boolean).join(' ');
    return [name, jsonType(p, components, 0, s), required.has(name) ? 'required' : '', desc];
  });
}

// ── zod → a one-line type (the MCP shapes; no extra dependency)

function zodType(z, depth = 0) {
  const d = z?._def;
  if (!d) return 'any';
  switch (d.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodBranded':
    case 'ZodReadonly':
    case 'ZodCatch':
      return zodType(d.innerType ?? d.type, depth);
    case 'ZodEffects':
      return zodType(d.schema, depth);
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return d.checks?.some((c) => c.kind === 'int') ? 'integer' : 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodLiteral':
      return JSON.stringify(d.value);
    case 'ZodEnum':
      return clampUnion(d.values.map((v) => `'${v}'`));
    case 'ZodNativeEnum':
      return Object.values(d.values)
        .map((v) => JSON.stringify(v))
        .join(' | ');
    case 'ZodArray':
      return `${zodType(d.type, depth + 1)}[]`;
    case 'ZodRecord':
      return `Record<string, ${zodType(d.valueType, depth + 1)}>`;
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const opts = d.options instanceof Map ? [...d.options.values()] : d.options;
      return clampUnion([...new Set(opts.map((o) => zodType(o, depth + 1)))]);
    }
    case 'ZodObject': {
      if (depth >= 1) return 'object';
      const keys = Object.keys(d.shape());
      return keys.length ? `{ ${keys.join(', ')} }` : 'object';
    }
    case 'ZodTuple':
      return `[${d.items.map((i) => zodType(i, depth + 1)).join(', ')}]`;
    case 'ZodUnknown':
    case 'ZodAny':
      return 'any';
    case 'ZodNull':
      return 'null';
    default:
      return d.typeName?.replace(/^Zod/, '').toLowerCase() ?? 'any';
  }
}

const zodOptional = (z) => typeof z?.isOptional === 'function' && z.isOptional();
const zodDescription = (z) => {
  // `.optional().describe(…)` puts the text on the wrapper; `.describe(…).optional()` on the inner.
  let cur = z;
  for (let i = 0; cur && i < 6; i++) {
    if (cur._def?.description) return cur._def.description;
    cur = cur._def?.innerType ?? cur._def?.type ?? cur._def?.schema;
  }
  return '';
};

// ─────────────────────────────────────────────── generated blocks

/** 5.x · every REST endpoint, its parameters, body and answers. */
function restBlock(doc, S) {
  const components = doc.components?.schemas ?? {};
  const out = [];
  // REST_ROUTES is the route table the server itself is built from — using it
  // as the order keeps the reference in the order a person reads the API in,
  // rather than whatever order an object happened to be built in.
  const order = S.REST_ROUTES.map((r) => `${r.method} ${r.path}`);
  const seen = new Set();
  const all = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      all.push({ path, method: method.toUpperCase(), op });
    }
  }
  all.sort((a, b) => {
    const ia = order.indexOf(`${a.method} ${a.path}`);
    const ib = order.indexOf(`${b.method} ${b.path}`);
    if (ia !== ib) return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
    return `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`);
  });

  for (const { path, method, op } of all) {
    const id = `${method} ${path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(`#### ${method} ${path}`);
    const route = S.REST_ROUTES.find((r) => r.method === method && r.path === path);
    if (op.summary) out.push(op.summary.replace(/\.?$/, '.'));
    const scopes = route ? route.scopes : [];
    out.push(
      `Scopes: ${scopes.length ? scopes.map((s) => `\`${s}\``).join(' or ') : '_none — any valid credential_'}` +
        (route?.board ? ' · board-scoped (a board token implies its board)' : ''),
    );

    const params = op.parameters ?? [];
    const group = (where) => params.filter((p) => p.in === where);
    for (const [label, where] of [
      ['Path', 'path'],
      ['Query', 'query'],
      ['Headers', 'header'],
    ]) {
      const ps = group(where);
      if (!ps.length) continue;
      out.push(
        `${label}:\n` +
          fence(
            'text',
            columns(
              ps.map((p) => [p.name, jsonType(p.schema, components), p.required ? 'required' : '', p.description ?? '']),
            ),
          ),
      );
    }

    const body = op.requestBody?.content ?? {};
    for (const [mime, c] of Object.entries(body)) {
      const lines = fieldLines(c.schema, components);
      out.push(
        `Body (${mime}${op.requestBody.required ? ', required' : ''}):\n` +
          (lines.length ? fence('text', columns(lines)) : '_(no fields)_'),
      );
    }

    const ok = Object.entries(op.responses ?? {}).filter(([code]) => code.startsWith('2'));
    const bad = Object.keys(op.responses ?? {}).filter((code) => !code.startsWith('2'));
    for (const [code, res] of ok) {
      const schema = res.content?.['application/json']?.schema ?? Object.values(res.content ?? {})[0]?.schema;
      const lines = schema ? fieldLines(schema, components) : [];
      out.push(
        `→ ${code} ${jsonType(schema, components)}` +
          (lines.length ? `\n` + fence('text', columns(lines)) : ''),
      );
    }
    if (bad.length) out.push(`→ ${bad.join(', ')} \`application/problem+json\` (see Errors)`);
    out.push('');
  }
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n');
}

/** 5.x · every MCP tool: description, scopes, input schema. */
function mcpBlock(S) {
  const out = [];
  out.push(
    columns([
      ['tool', 'scopes', 'what it does'],
      ['────', '──────', '────────────'],
      ...Object.entries(S.MCP_TOOLS).map(([name, meta]) => [
        name,
        meta.scopes.length ? meta.scopes.join(' | ') : '(any)',
        meta.description,
      ]),
    ]),
  );
  const table = fence('text', out.pop());
  const blocks = [table, ''];
  for (const [name, meta] of Object.entries(S.MCP_TOOLS)) {
    const shape = S.McpToolShapes[name];
    const fields = Object.entries(shape).map(([k, v]) => [
      k,
      zodType(v),
      zodOptional(v) ? '' : 'required',
      zodDescription(v),
    ]);
    blocks.push(`#### ${name}`);
    blocks.push(meta.description);
    blocks.push(
      `${meta.readOnly ? 'Read-only' : 'Writes'} · scopes: ${meta.scopes.length ? meta.scopes.map((s) => `\`${s}\``).join(' or ') : '_any credential_'}`,
    );
    blocks.push(fields.length ? fence('text', columns(fields)) : '_No arguments._');
    blocks.push('');
  }
  blocks.push('Resources (MCP `resources/read`):');
  blocks.push(
    fence(
      'text',
      columns(
        Object.entries(S.MCP_RESOURCES).map(([k, uri]) => [uri, `(${k})`]),
      ),
    ),
  );
  blocks.push(`Prompts: ${S.MCP_PROMPTS.map((p) => `\`${p}\``).join(', ')}`);
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n');
}

/** 5.x · the contracts every door shares. */
function contractsBlock(S, doc) {
  const b = [];

  b.push('##### Scopes');
  b.push(
    'A token carries scopes. **What it may do is its scopes ∩ what its principal’s board role allows** — a scope never widens a role.',
  );
  b.push(
    fence(
      'text',
      columns([
        ['scope', 'what it allows'],
        ['─────', '──────────────'],
        ...S.TOKEN_SCOPES.map((s) => [s, S.SCOPE_LABELS[s]]),
        ['', ''],
        ...S.ADMIN_SCOPES.map((s) => [s, `${S.SCOPE_LABELS[s]} — only a token acting as a PERSON who is a board admin`]),
      ]),
    ),
  );
  b.push('Presets offered by the token form:');
  b.push(
    fence(
      'text',
      Object.entries(S.SCOPE_PRESETS)
        .map(([name, list]) => `${pad(S.SCOPE_PRESET_LABELS[name], 10)} ${list.join(' ')}`)
        .join('\n\n'),
    ),
  );

  b.push('##### Event types (the inbox: `GET /v1/events`, MCP `get_events`)');
  b.push(
    fence(
      'text',
      columns([
        ...S.AGENT_EVENT_TYPES.map((t) => [t, EVENT_NOTES[t] ?? '']),
      ]),
    ),
  );
  b.push(
    'An event is `{ id, type, board, ticket_id, ticket_key, message_id, actor, summary, created_at, acked_at }` — ' +
      '`ticket_key` is the `ENG-42` you act on, and is null for an event about no ticket in particular. ' +
      '`question_answered` and `question_cancelled` also carry `question: { id, title, status, values, comment, answered_by }`, ' +
      'so acting on the answer needs no second call.',
  );
  b.push(
    `Notification events people can receive (webhooks and their own channels, not the agent inbox): ${S.NOTIFY_EVENTS.map((e) => `\`${e}\``).join(', ')}.`,
  );
  b.push(`Webhook events: ${S.WEBHOOK_EVENTS.map((e) => `\`${e}\``).join(', ')}.`);

  b.push('##### Error codes');
  b.push('Every door answers RFC 9457 `application/problem+json` with the same `code`:');
  b.push(
    fence(
      'text',
      columns([
        ['code', 'status', 'title', 'means'],
        ['────', '──────', '─────', '─────'],
        ...S.APP_ERROR_CODES.map((c) => [c, S.ERROR_STATUS[c], S.ERROR_TITLES[c], ERROR_NOTES[c] ?? '']),
      ]),
    ),
  );
  b.push(
    'The body is `{ type, title, status, detail?, instance?, code, … }` — `issues` on a 400 from zod, `retryAfter` on a 429, ' +
      '`missing` on a 422 from a stage’s `requires`.',
  );

  b.push('##### States and vocabularies');
  b.push(
    fence(
      'text',
      columns([
        ['ticket state', S.TICKET_STATES.join(' | ')],
        ['stage category', S.STAGE_CATEGORIES.join(' | ')],
        ['custom field type', S.FIELD_TYPES.join(' | ')],
        ['board role', S.BOARD_ROLES.join(' | ')],
        ['principal kind', "'user' | 'agent'  (an agent id is 'ag_' + 16 chars)"],
        ['question status', S.QUESTION_STATUSES.join(' | ')],
        ['question field type', S.QUESTION_FIELD_TYPES.join(' | ')],
        ['task item status', S.TASK_ITEM_STATUSES.join(' | ')],
        ['agent heartbeat state', S.AGENT_STATES.join(' | ')],
        ['link type', S.TICKET_LINK_TYPES.join(' | ')],
        ['file kind', S.FILE_KINDS.join(' | ')],
        ['via (where a change came from)', S.VIAS.join(' | ')],
      ]),
    ),
  );

  b.push('##### Limits');
  b.push(
    fence(
      'text',
      columns([
        ['upload', `${S.MAX_API_UPLOAD_BYTES / 1024 / 1024} MB per file (multipart, or JSON text / base64)`],
        ['attachments per message', `${S.MAX_ATTACHMENTS_PER_CALL}`],
        ['task list', `${S.MAX_TASKLIST_ITEMS} items, title ≤ ${S.TASKLIST_TITLE_MAX}, item ≤ ${S.TASK_ITEM_TITLE_MAX}, note ≤ ${S.TASK_ITEM_NOTE_MAX}`],
        ['question', `${S.MAX_QUESTION_FIELDS} fields, ${S.MAX_QUESTION_OPTIONS} options per field, title ≤ ${S.QUESTION_TITLE_MAX}`],
        ['heartbeat', `every 60 s while working; stale after 75 s; message ≤ ${S.AGENT_STATUS_MESSAGE_MAX}`],
        ['api key', 'default 60 requests/min and 10 000/day, per token'],
        ['oauth / mcp session', '120 requests/min and 20 000/day, per grant'],
        ['ticket description', '≤ 100 000 characters of Markdown'],
        ['events ack', `≤ ${S.MAX_ACK_IDS} ids per call`],
        ['SSE stream', 'ends at ~50 s (it lives inside a 60 s function) — reconnect from the cursor; that is normal'],
      ]),
    ),
  );
  b.push(
    `OpenAPI: \`${doc.info?.title ?? '/v1'}\` version \`${doc.info?.version ?? '1'}\`, ${Object.keys(doc.paths).length} paths, ${Object.keys(doc.components?.schemas ?? {}).length} schemas.`,
  );
  return b.join('\n\n');
}

/** Short notes next to the generated vocabularies — the meaning the lists cannot carry. */
const EVENT_NOTES = {
  assigned: 'you were put on a ticket — the usual trigger to start work',
  unassigned: 'you were taken off it; stop',
  mentioned: 'a message names you (@your-agent-name)',
  comment: 'a new message on a ticket you are on',
  stage: 'the ticket moved to another stage',
  updated: 'title, fields, dates, tags or links changed',
  created: 'a ticket you watch was created',
  question_answered: 'somebody submitted the form you asked — `event.question.values` is here',
  question_cancelled: 'your question was cancelled or expired; stop waiting',
};

const ERROR_NOTES = {
  invalid: 'the input failed validation, or names something not on the board',
  unauthenticated: 'no / bad / revoked / expired token — do not retry',
  forbidden: 'the role or the scope says no — do not retry',
  not_found: 'gone, or on a board you cannot read (existence is never leaked)',
  conflict: 'a state conflict: key taken, stale update, ticket not active',
  gone: 'it existed and is gone (an expired invite, a cancelled question)',
  too_large: 'over the body or attachment limit',
  unprocessable: 'well-formed, but a board rule refuses it (a stage’s `requires`)',
  rate_limited: 'back off — `Retry-After` says how long (the SDK does this for you)',
  internal: 'a bug on our side; retry with backoff',
  unavailable: 'a dependency is down; safe to retry',
};

/**
 * 5.x · the SDK surface, taken VERBATIM out of sdk/dist/sdk.d.ts. Verbatim
 * because a paraphrase is a second copy, and a second copy rots.
 */
function sdkBlock(dts, version, u) {
  const surface = sliceBraces(dts, /declare function createClientBase\(options: ClientOptions\): \{/);
  if (!surface) fail('could not find createClientBase in sdk/dist/sdk.d.ts — has the SDK build changed shape?');
  const extras = [
    sliceBraces(dts, /export interface TmClient extends TmClientBase \{/),
    sliceBraces(dts, /export interface WorkContext \{/),
    sliceBraces(dts, /export interface WorkOptions \{/),
    sliceBraces(dts, /export interface McpTool \{/),
    sliceBraces(dts, /export interface McpToolsOptions \{/),
  ].filter(Boolean);

  const exported = [...dts.matchAll(/^export declare (?:function|const|class) (\w+)/gm)].map((m) => m[1]);
  const types = [...dts.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]);

  return [
    `\`@tm/sdk\` **${version}** — zero dependencies, one injectable \`fetch\`; Node 20+, Deno, Bun and browsers.`,
    'Everything below is copied out of the published `sdk.d.ts`, so a signature here is the signature that compiles.',
    fence('ts', `import { createClient } from '${u.sdk.esm}';\n\nconst tm = createClient({ token: process.env.TM_TOKEN });`),
    '`createClient()` returns the object below, plus `work()` (see `TmClient`):',
    fence('ts', surface),
    ...extras.map((e) => fence('ts', e)),
    `Exported values: ${exported.map((n) => `\`${n}\``).join(', ')}.`,
    `Exported types: ${types.map((n) => `\`${n}\``).join(', ')}.`,
  ].join('\n\n');
}

/** From the line a regex matches, through the balanced `{ … }` that follows. */
function sliceBraces(text, startRe) {
  const m = startRe.exec(text);
  if (!m) return null;
  let depth = 0;
  let i = m.index;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  // Carry the doc comment that sits IMMEDIATELY above the declaration, if there
  // is one. Found by walking back from the declaration rather than by a regex:
  // a lazy `/**…*/$` match happily swallows the whole file up to this point.
  const before = text.slice(0, m.index).replace(/\s+$/, '');
  let doc = '';
  if (before.endsWith('*/')) {
    const start = before.lastIndexOf('/**');
    if (start >= 0) doc = before.slice(start) + '\n';
  }
  return (doc + text.slice(m.index, i)).trim();
}

// ─────────────────────────────────────────────────────── assembly

/** Every URL the page talks about, in one place. */
export function urls(project = DEFAULT_PROJECT) {
  const host = `https://${project}.web.app`;
  return {
    host,
    app: host,
    apiBase: `${host}/v1`,
    mcpUrl: `${host}/mcp`,
    openapiUrl: `${host}/v1/openapi.json`,
    llmsUrl: `${host}/llms.txt`,
    llmsFullUrl: `${host}/llms-full.txt`,
    integrateUrl: `${host}/integrate`,
    manifestUrl: `${host}/integrate.json`,
    // §R3 — TaskManager inside Claude: the guide, and the plugin it hands out.
    claudeUrl: `${host}/integrate/claude`,
    pluginZipUrl: `${host}/lib/claude-plugin.zip`,
    pluginDirUrl: `${host}/lib/claude-plugin/`,
    tokensUrl: `${host}/account/tokens`,
    connectedAppsUrl: `${host}/account/connected-apps`,
    sdk: {
      index: `${host}/lib/`,
      esm: `${host}/lib/v1/sdk.js`,
      esmMin: `${host}/lib/v1/sdk.min.js`,
      ts: `${host}/lib/v1/sdk.ts`,
      types: `${host}/lib/v1/sdk.d.ts`,
      tarball: `${host}/lib/v1/tm-sdk.tgz`,
      manifest: `${host}/lib/v1/sdk.json`,
      openapi: `${host}/lib/v1/openapi.json`,
      latest: `${host}/lib/latest/sdk.js`,
    },
  };
}

/** `{{gen:name}}` and `{{url:path.to.value}}` in the prose. */
function expand(md, blocks, u, vars) {
  return md
    .replace(/\{\{gen:([a-z]+)\}\}/g, (_, name) => {
      if (!(name in blocks)) fail(`unknown generated block {{gen:${name}}} in the prose`);
      return blocks[name];
    })
    .replace(/\{\{url:([a-zA-Z.]+)\}\}/g, (_, path) => {
      const v = path.split('.').reduce((o, k) => o?.[k], u);
      if (typeof v !== 'string') fail(`unknown {{url:${path}}} in the prose`);
      return v;
    })
    .replace(/\{\{HOST\}\}/g, u.host)
    .replace(/\{\{VERSION\}\}/g, vars.version)
    .replace(/\{\{UPDATED\}\}/g, vars.updated);
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Every `##`/`###` heading, for the table of contents and the page's sidebar. */
function headings(md) {
  const out = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], id: slug(m[2]) });
  }
  return out;
}

export async function generate({ project = DEFAULT_PROJECT } = {}) {
  const prose = await loadProse();
  const pluginSource = await loadPluginSource();
  const S = await loadShared();
  const { dts, version } = loadSdk();
  const doc = openApiDoc(project);
  const u = urls(project);

  const changelogMd = prose['90-changelog.md'] ?? '';
  const changelog = parseChangelog(changelogMd, version);
  const updated = changelog[0].date;

  const blocks = {
    rest: restBlock(doc, S),
    mcp: mcpBlock(S),
    contracts: contractsBlock(S, doc),
    sdk: sdkBlock(dts, version, u),
    tools: toolTable(S),
    toc: '{{TOC}}', // filled in below, once every heading exists
  };

  // llms-full.txt — the numbered prose files, in order, with the generated
  // blocks spliced in where each file asks for them.
  const body = Object.keys(prose)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => expand(prose[n], blocks, u, { version, updated }).trim())
    .join('\n\n');

  // Linked, so the readable page's contents list is clickable; the anchors are
  // the same slugs the page gives its headings.
  const toc = headings(body)
    .map((h) => `${h.level === 2 ? '' : '  '}- [${h.text}](#${h.id})`)
    .join('\n');
  const withToc = body.replace('{{TOC}}', toc);

  const sha = createHash('sha256').update(withToc).digest('hex');
  const header = [
    `# TaskManager — integration context`,
    '',
    `> The whole operating context for an orchestrator, in one file. Generated from this app's own`,
    `> OpenAPI document, MCP tool registry, shared contracts and SDK declaration file — it cannot`,
    `> drift from the software it describes.`,
    '',
    columns([
      ['version:', version],
      ['api:', 'v1'],
      ['updated:', `${updated}  (the newest changelog entry — this file is byte-stable between releases on purpose)`],
      ['content-sha256:', sha],
      ['source:', 'scripts/gen-integration.mjs'],
      ['this file:', u.llmsFullUrl],
      ['readable page:', u.integrateUrl],
      ['machine manifest:', u.manifestUrl],
      ['short index:', u.llmsUrl],
    ]),
    '',
    '---',
    '',
  ].join('\n');
  const llmsFull = header + withToc + '\n';

  // llms.txt — the short index (the orientation is prose; the URLs are generated).
  const urlTable = columns([
    [u.llmsFullUrl, 'THE ONE PAGE — the whole operating context, Markdown'],
    [u.integrateUrl, 'the same thing as a readable web page, for humans'],
    [u.manifestUrl, 'a machine manifest: api, mcp, sdk, openapi and llms URLs + version'],
    [u.openapiUrl, 'the OpenAPI 3.1 description of /v1'],
    [u.sdk.index, 'the hosted JavaScript SDK: install lines and examples'],
    [u.claudeUrl, 'putting this inside Claude: connector, `claude mcp add`, or the plugin'],
    [u.pluginZipUrl, 'the Claude Code plugin: MCP server + skill + slash commands'],
    [u.apiBase, 'the REST API root (Bearer token)'],
    [u.mcpUrl, 'the MCP endpoint (the same token as a Bearer token)'],
  ]);
  const llms = expand(prose['index.md'], { ...blocks, urls: urlTable }, u, { version, updated }).trim() + '\n';

  // integrate.json — everything a machine needs to bootstrap, and nothing it has to parse prose for.
  const manifest = {
    name: 'TaskManager',
    description: 'Boards, tickets and threads that people and agents share. One token, three doors: SDK, REST, MCP.',
    version,
    apiVersion: 'v1',
    updated,
    contentSha256: sha,
    app: u.app,
    apiBase: u.apiBase,
    mcpUrl: u.mcpUrl,
    openapiUrl: u.openapiUrl,
    llmsUrl: u.llmsUrl,
    llmsFullUrl: u.llmsFullUrl,
    integrateUrl: u.integrateUrl,
    claude: {
      guideUrl: u.claudeUrl,
      connectorUrl: u.mcpUrl,
      pluginZipUrl: u.pluginZipUrl,
      pluginDirUrl: u.pluginDirUrl,
      pluginName: 'taskmanager',
      mcpAddCommand: `claude mcp add --transport http taskmanager ${u.mcpUrl} --header "Authorization: Bearer $TM_TOKEN"`,
    },
    sdk: u.sdk,
    auth: {
      scheme: 'Bearer',
      header: 'Authorization: Bearer tm_live_…',
      tokenPrefix: 'tm_live_',
      howToGetOne: `${u.app}/account/tokens — a person makes an agent, adds it to a board, and creates a board-scoped token that acts as it.`,
      boardScoped: true,
      idempotencyHeader: S.IDEMPOTENCY_HEADER,
    },
    scopes: S.TOKEN_SCOPES.map((name) => ({ name, label: S.SCOPE_LABELS[name] })),
    adminScopes: S.ADMIN_SCOPES.map((name) => ({ name, label: S.SCOPE_LABELS[name] })),
    scopePresets: Object.fromEntries(Object.entries(S.SCOPE_PRESETS).map(([k, v]) => [k, [...v]])),
    events: S.AGENT_EVENT_TYPES.map((type) => ({ type, means: EVENT_NOTES[type] ?? '' })),
    notifyEvents: [...S.NOTIFY_EVENTS],
    errorCodes: S.APP_ERROR_CODES.map((code) => ({ code, status: S.ERROR_STATUS[code], means: ERROR_NOTES[code] ?? '' })),
    rest: S.REST_ROUTES.map((r) => ({ method: r.method, path: r.path, scopes: [...r.scopes], summary: r.summary })),
    mcpTools: Object.entries(S.MCP_TOOLS).map(([name, meta]) => ({
      name,
      description: meta.description,
      readOnly: meta.readOnly,
      scopes: [...meta.scopes],
    })),
    limits: {
      uploadBytes: S.MAX_API_UPLOAD_BYTES,
      tasklistItems: S.MAX_TASKLIST_ITEMS,
      questionFields: S.MAX_QUESTION_FIELDS,
      heartbeatIntervalMs: 60_000,
      heartbeatStaleMs: 75_000,
      requestsPerMinute: 60,
      requestsPerDay: 10_000,
    },
    changelog,
  };

  // The Claude guide (§R3). Its prose is claude.md — a NON-numbered source
  // file, so it is a page of its own and never lands inside llms-full.txt.
  // NB the source file is integrate-claude.md, not claude.md: a file named
  // claude.md sits at CLAUDE.md on a case-insensitive filesystem, and would be
  // read as project instructions by every Claude session in this repo.
  if (!prose['integrate-claude.md'])
    fail(`${relative(ROOT, SOURCE)}/integrate-claude.md is missing (the /integrate/claude guide)`);
  const claudeBody = expand(prose['integrate-claude.md'], blocks, u, { version, updated }).trim();

  // The plugin bundle. The skill carries llms-full.txt VERBATIM as a reference
  // file: an installed plugin then holds the whole operating context offline,
  // and `{{url:llmsFullUrl}}` in the skill tells Claude where the live one is.
  const pluginFiles = {};
  for (const [name, text] of Object.entries(pluginSource)) {
    pluginFiles[name] = expand(text, blocks, u, { version, updated });
  }
  pluginFiles[join('skills', 'taskmanager', 'reference', 'llms-full.txt')] = llmsFull;
  const missing = PLUGIN_FILES.filter((f) => !(f in pluginFiles));
  if (missing.length)
    fail(`the Claude plugin is missing ${missing.join(', ')} — add the template under ${relative(ROOT, SOURCE)}/claude-plugin/`);
  const extra = Object.keys(pluginFiles).filter((f) => !PLUGIN_FILES.includes(f));
  if (extra.length) fail(`unexpected Claude plugin file(s): ${extra.join(', ')} — add them to PLUGIN_FILES`);

  // One entry per file, in PLUGIN_FILES order, under a single top-level folder
  // so `unzip claude-plugin.zip` leaves a directory you can point Claude at.
  const zip = zipBytes(
    PLUGIN_FILES.map((f) => ({
      name: `${PLUGIN_NAME}/${f.split('\\').join('/')}`,
      data: Buffer.from(pluginFiles[f], 'utf8'),
    })),
    updated,
  );

  return {
    version,
    updated,
    sha,
    files: {
      'llms.txt': llms,
      'llms-full.txt': llmsFull,
      'integrate.json': JSON.stringify(manifest, null, 2) + '\n',
      [join('integrate', 'index.html')]: renderPage(withToc, { version, updated, sha, u }),
      [join('integrate', 'claude', 'index.html')]: renderClaudePage(claudeBody, { version, updated, u }),
      ...Object.fromEntries(PLUGIN_FILES.map((f) => [join(PLUGIN_DIR, f), pluginFiles[f]])),
    },
    binaries: { [PLUGIN_ZIP]: zip },
    stats: {
      restPaths: S.REST_ROUTES.length,
      mcpTools: Object.keys(S.MCP_TOOLS).length,
      scopes: S.SCOPES.length,
      bytes: llmsFull.length,
      zipBytes: zip.length,
    },
  };
}

// ─────────────────────────────────── the Claude plugin bundle (§R3)

/**
 * The plugin's own files are TEMPLATES, beside the prose, under
 * scripts/integration-source/claude-plugin/. They carry the same
 * `{{url:…}}` / `{{gen:…}}` / `{{VERSION}}` markers the prose does, so the
 * skill a person installs states this deployment's URLs and this release's
 * contracts — never a hand-copied version of them.
 */
async function loadPluginSource() {
  const dir = join(SOURCE, 'claude-plugin');
  const out = {};
  const walk = async (rel) => {
    let entries;
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      fail(`${relative(ROOT, join(dir, rel))} is missing — the Claude plugin's templates live there`);
    }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) await walk(r);
      else out[r] = await readFile(join(dir, r), 'utf8');
    }
  };
  await walk('');
  return out;
}

/** A compact `tool  what it does` table — the orientation a skill needs, not the full schema. */
function toolTable(S) {
  return columns(
    Object.entries(S.MCP_TOOLS).map(([name, meta]) => [name, meta.readOnly ? 'read' : 'write', meta.description]),
  );
}

// ── a deterministic zip

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * STORE only (no deflate) and a modification time taken from the changelog
 * date rather than the clock: the deploy's guard compares this archive byte
 * for byte, so it must be a pure function of its contents. zlib's output is
 * not guaranteed stable across Node versions; storing costs ~90 kB of an
 * archive nobody streams, and buys a check that cannot flake.
 */
function zipBytes(entries, updated) {
  const [y, m, d] = updated.split('-').map(Number);
  const dosDate = ((y - 1980) << 9) | (m << 5) | d;
  const dosTime = 0; // 00:00:00
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(10, 4); // version needed: 1.0 (store)
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(0, 8); // method: store
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(10, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes: a regular file (unix 0644)
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, end]);
}

// ──────────────────────────────────────────── the readable page

/**
 * A tiny, deterministic Markdown → HTML renderer. Small on purpose: the input
 * is Markdown THIS script wrote, so it only has to handle what we emit, and a
 * dependency here would be a dependency the deploy has to install.
 */
function inline(s) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Inline code is lifted out first and put back last, so the emphasis and link
  // rules below cannot reach inside a code span. The sentinel is a private-use
  // code point: it can never occur in the source Markdown.
  const MARK = '\uE000';
  const codes = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_, c) => `${MARK}${codes.push(`<code>${c}</code>`) - 1}${MARK}`);
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s.,)]|$)/g, '$1<em>$2</em>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w/])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
  return out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, i) => codes[Number(i)]);
}

function markdownToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const lang = line.slice(3).trim() || 'text';
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const code = buf.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      out.push(
        `<figure class="code" data-lang="${lang}"><button class="copy" type="button" aria-label="Copy this block">Copy</button><pre><code>${code}</code></pre></figure>`,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      const id = slug(h[2]);
      out.push(
        `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inline(h[2])}</h${level}>`,
      );
      i++;
      continue;
    }
    if (/^(---|\*\*\*)\s*$/.test(line)) {
      flush();
      out.push('<hr />');
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdownToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m) {
          // A wrapped continuation line belongs to the item above it.
          if (items.length && /^\s+\S/.test(lines[i]) && !/^```/.test(lines[i].trim())) {
            items[items.length - 1] += ' ' + lines[i].trim();
            i++;
            continue;
          }
          break;
        }
        items.push(m[3]);
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('\n');
}

/**
 * The look of both published pages — /integrate and /integrate/claude — in one
 * place, so the guide cannot drift from the reference it links to. Plain CSS
 * in a plain file: these pages are read by people wiring an orchestrator up,
 * often signed out, and must not wait on the SPA bundle.
 */
const PAGE_CSS = `    <style>
      :root {
        color-scheme: light;
        --bg: #f7f6f3;
        --surface: #ffffff;
        --surface-2: #f1efeb;
        --line: #e3e0da;
        --text: #1f1d1a;
        --muted: #6b6560;
        --subtle: #9a938c;
        --accent: #3f5fe0;
        --accent-soft: #e7ebfc;
        --code-bg: #1c1b19;
        --code-fg: #ece9e4;
        --mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          color-scheme: dark;
          --bg: #151413;
          --surface: #1c1b19;
          --surface-2: #252320;
          --line: #2f2c29;
          --text: #ece9e4;
          --muted: #a39d96;
          --subtle: #78726c;
          --accent: #7089f5;
          --accent-soft: #252c4a;
          --code-bg: #0f0e0d;
          --code-fg: #ece9e4;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font: 15px/1.65 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        -webkit-text-size-adjust: 100%;
      }
      .wrap { display: grid; grid-template-columns: 15rem minmax(0, 1fr); gap: 2.5rem; max-width: 66rem; margin: 0 auto; padding: 0 1.25rem 6rem; }
      header.top { max-width: 66rem; margin: 0 auto; padding: 2.5rem 1.25rem 1.25rem; }
      header.top h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .4rem; letter-spacing: -0.02em; }
      header.top p { margin: 0 0 1rem; color: var(--muted); max-width: 46rem; }
      .stamp { display: flex; flex-wrap: wrap; gap: .5rem; font: 12px/1.4 var(--mono); color: var(--muted); }
      .stamp span { background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; padding: .2rem .6rem; }
      nav.toc { position: sticky; top: 1.5rem; align-self: start; max-height: calc(100vh - 3rem); overflow: auto; display: flex; flex-direction: column; gap: .1rem; font-size: 13.5px; border-left: 1px solid var(--line); padding-left: .9rem; }
      nav.toc a { color: var(--muted); text-decoration: none; padding: .2rem 0; border-radius: 4px; }
      nav.toc a:hover { color: var(--text); }
      nav.toc a.on { color: var(--accent); font-weight: 600; }
      main { min-width: 0; }
      h2 { font-size: 1.35rem; margin: 3rem 0 .75rem; padding-top: .5rem; letter-spacing: -0.015em; scroll-margin-top: 1.5rem; }
      h3 { font-size: 1.08rem; margin: 2rem 0 .5rem; scroll-margin-top: 1.5rem; }
      h4 { font-size: .95rem; margin: 1.6rem 0 .4rem; font-family: var(--mono); color: var(--accent); scroll-margin-top: 1.5rem; }
      h5 { font-size: .95rem; margin: 1.4rem 0 .4rem; scroll-margin-top: 1.5rem; }
      h2, h3, h4, h5 { position: relative; }
      .anchor { position: absolute; left: -1rem; color: var(--subtle); text-decoration: none; opacity: 0; font-weight: 400; }
      h2:hover .anchor, h3:hover .anchor, h4:hover .anchor, h5:hover .anchor, .anchor:focus { opacity: 1; }
      p, li { max-width: 46rem; }
      a { color: var(--accent); }
      code { font-family: var(--mono); font-size: .875em; background: var(--surface-2); border: 1px solid var(--line); border-radius: 4px; padding: .05em .35em; word-break: break-word; }
      blockquote { margin: 1rem 0; padding: .1rem 1rem; border-left: 3px solid var(--line); color: var(--muted); }
      hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }
      figure.code { position: relative; margin: .9rem 0; }
      figure.code pre { margin: 0; overflow: auto; background: var(--code-bg); color: var(--code-fg); border-radius: 10px; padding: .9rem 1rem; font-size: 12.5px; line-height: 1.55; }
      figure.code pre code { background: none; border: 0; padding: 0; color: inherit; font-size: inherit; }
      figure.code .copy { position: absolute; top: .5rem; right: .5rem; opacity: 0; transition: opacity .12s; background: rgba(255,255,255,.1); color: var(--code-fg); border: 1px solid rgba(255,255,255,.18); border-radius: 6px; font: 11px var(--mono); padding: .25rem .5rem; cursor: pointer; }
      figure.code:hover .copy, figure.code .copy:focus { opacity: 1; }
      ul, ol { padding-left: 1.25rem; }
      li { margin: .2rem 0; }
      footer { max-width: 66rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; color: var(--subtle); font-size: 13px; border-top: 1px solid var(--line); }
      @media (max-width: 52rem) {
        .wrap { grid-template-columns: minmax(0, 1fr); gap: 1rem; }
        nav.toc { position: static; max-height: none; border-left: 0; border-bottom: 1px solid var(--line); padding: 0 0 .75rem; flex-direction: row; flex-wrap: wrap; gap: .75rem; }
      }
    </style>
`;

/** Copy buttons and a contents list that follows the reading position. */
const PAGE_SCRIPT = `    <script>
      // Copy buttons, and a table of contents that follows the reading position.
      for (const b of document.querySelectorAll('figure.code .copy')) {
        b.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(b.parentElement.querySelector('code').textContent);
            const was = b.textContent;
            b.textContent = 'Copied';
            setTimeout(() => (b.textContent = was), 1200);
          } catch {
            b.textContent = 'Press ⌘C';
          }
        });
      }
      const links = new Map([...document.querySelectorAll('nav.toc a')].map((a) => [a.getAttribute('href').slice(1), a]));
      const spy = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            for (const a of links.values()) a.classList.remove('on');
            links.get(e.target.id)?.classList.add('on');
          }
        },
        { rootMargin: '0px 0px -75% 0px' },
      );
      for (const id of links.keys()) {
        const el = document.getElementById(id);
        if (el) spy.observe(el);
      }
    </script>
`;

function renderPage(body, { version, updated, sha, u }) {
  const nav = headings(body)
    .filter((h) => h.level === 2)
    .map((h) => `<a href="#${h.id}">${h.text.replace(/^\d+\.\s*/, '')}</a>`)
    .join('\n        ');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Integrate · TaskManager</title>
    <meta
      name="description"
      content="Everything an orchestrator needs to work with TaskManager: tokens, the three doors (SDK, REST, MCP), a runnable example, the generated reference and the rules of the house."
    />
    <link rel="icon" href="/favicon.svg" />
    <!--
      GENERATED by scripts/gen-integration.mjs — do not edit. The prose lives in
      scripts/integration-source/*.md; everything else comes from the OpenAPI
      document, the MCP registry, @tm/shared and sdk.d.ts.

      A PLAIN STATIC FILE on purpose, like /lib/index.html: this is read by
      people wiring up an orchestrator, often with no session, and it must not
      depend on the SPA bundle loading. The only script wires the copy buttons
      and the scroll-spy; everything reads correctly without it.
    -->
${PAGE_CSS}  </head>
  <body>
    <header class="top">
      <h1>Integrate TaskManager</h1>
      <p>
        Everything an orchestrator needs, on one page — generated from this app's own OpenAPI document, MCP tool
        registry, shared contracts and SDK types. Point your agent at
        <a href="/llms-full.txt">/llms-full.txt</a> for the same content as plain Markdown.
      </p>
      <div class="stamp">
        <span>version ${esc(version)}</span>
        <span>api v1</span>
        <span>updated ${esc(updated)}</span>
        <span>sha256 ${esc(sha.slice(0, 12))}…</span>
        <span><a href="/llms-full.txt">llms-full.txt</a></span>
        <span><a href="/llms.txt">llms.txt</a></span>
        <span><a href="/integrate.json">integrate.json</a></span>
        <span><a href="/v1/openapi.json">openapi.json</a></span>
        <span><a href="/lib/">SDK</a></span>
        <span><a href="/integrate/claude">Claude</a></span>
      </div>
    </header>
    <div class="wrap">
      <nav class="toc" aria-label="On this page">
        ${nav}
      </nav>
      <main>
${markdownToHtml(body)}
      </main>
    </div>
    <footer>
      Generated by <code>scripts/gen-integration.mjs</code> from the OpenAPI document, the MCP tool registry,
      <code>@tm/shared</code> and <code>sdk.d.ts</code>. The deploy fails when this page is out of date.
      · <a href="${u.llmsFullUrl}">${u.llmsFullUrl}</a>
    </footer>
${PAGE_SCRIPT}  </body>
</html>
`;
}

/**
 * /integrate/claude (§R3) — the same page furniture as /integrate, a different
 * body. Deliberately NOT part of llms-full.txt: that file is what an
 * orchestrator reads, and this one is what a person does once, by hand, to put
 * TaskManager inside Claude.
 */
function renderClaudePage(body, { version, updated, u }) {
  const nav = headings(body)
    .filter((h) => h.level === 2)
    .map((h) => `<a href="#${h.id}">${h.text.replace(/^\d+\.\s*/, '')}</a>`)
    .join('\n        ');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TaskManager in Claude · TaskManager</title>
    <meta
      name="description"
      content="Three ways to put TaskManager inside Claude: a custom connector over OAuth, one claude mcp add command, or the downloadable plugin with its skill and slash commands — plus using a board as Claude's memory palace."
    />
    <link rel="icon" href="/favicon.svg" />
    <!--
      GENERATED by scripts/gen-integration.mjs — do not edit. The prose lives in
      scripts/integration-source/claude.md and the plugin's own files in
      scripts/integration-source/claude-plugin/**; the URLs, the version and the
      tool list come from the same software this page describes.
    -->
${PAGE_CSS}  </head>
  <body>
    <header class="top">
      <h1>TaskManager in Claude</h1>
      <p>
        Your boards, tickets and threads inside Claude — as a connector, as one <code>claude mcp add</code> command, or as a
        plugin that brings its own skill and slash commands. Everything below is copy-paste, and every route uses the same
        <a href="/integrate#2-how-an-agent-gets-in">token model</a> the rest of the API does.
      </p>
      <div class="stamp">
        <span>version ${esc(version)}</span>
        <span>api v1</span>
        <span>updated ${esc(updated)}</span>
        <span><a href="/integrate">integrate</a></span>
        <span><a href="/llms-full.txt">llms-full.txt</a></span>
        <span><a href="${u.pluginZipUrl}">claude-plugin.zip</a></span>
        <span><a href="${u.pluginDirUrl}">plugin files</a></span>
        <span><a href="/account/tokens">your tokens</a></span>
      </div>
    </header>
    <div class="wrap">
      <nav class="toc" aria-label="On this page">
        ${nav}
      </nav>
      <main>
${markdownToHtml(body)}
      </main>
    </div>
    <footer>
      Generated by <code>scripts/gen-integration.mjs</code>. The plugin this page hands out is generated with it, from the
      same MCP registry and contracts — so the skill it installs describes this deployment, not a copy of it.
      · <a href="${u.integrateUrl}">${u.integrateUrl}</a>
    </footer>
${PAGE_SCRIPT}  </body>
</html>
`;
}


// ─────────────────────────────────────────────────────────── cli

export async function write({ project = DEFAULT_PROJECT, out = STATIC } = {}) {
  const res = await generate({ project });
  for (const [name, text] of Object.entries({ ...res.files, ...res.binaries })) {
    const p = join(out, name);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text);
  }
  return res;
}

/**
 * The guard: what is committed must equal a fresh generation. Same idea as the
 * SDK artefacts — a page that describes yesterday's API is worse than no page.
 */
export async function check({ project = DEFAULT_PROJECT, dir = STATIC } = {}) {
  const res = await generate({ project });
  const stale = [];
  for (const [name, text] of Object.entries(res.files)) {
    const p = join(dir, name);
    let have = null;
    try {
      have = await readFile(p, 'utf8');
    } catch {
      /* missing */
    }
    if (have !== text) stale.push({ name, missing: have === null, path: relative(ROOT, p) });
  }
  // The zip is derived from files that are checked above, but it is compared
  // anyway — and as BYTES, not as text: a lossy utf-8 decode would happily
  // call two different archives equal.
  for (const [name, buf] of Object.entries(res.binaries)) {
    const p = join(dir, name);
    let have = null;
    try {
      have = await readFile(p);
    } catch {
      /* missing */
    }
    if (have === null || !have.equals(buf)) stale.push({ name, missing: have === null, path: relative(ROOT, p) });
  }
  return { ...res, stale };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const project = opt('--project') ?? process.env.TM_DEPLOY_PROJECT ?? DEFAULT_PROJECT;
  const out = opt('--out') ? (opt('--out').startsWith('/') ? opt('--out') : join(ROOT, opt('--out'))) : STATIC;
  try {
    if (flag('--check')) {
      const res = await check({ project, dir: out });
      if (res.stale.length)
        fail(
          `the published integration context is out of date:\n` +
            res.stale.map((s) => `      ${s.missing ? 'missing' : 'stale  '}  ${s.path}`).join('\n') +
            '\n    run:  pnpm integrate:gen     (and commit the result)',
        );
      log(`up to date — ${OUTPUTS.length + BINARIES.length} files, @tm/sdk ${res.version}, updated ${res.updated}`);
    } else {
      const res = await write({ project, out });
      log(
        `wrote ${OUTPUTS.length + BINARIES.length} files → ${relative(ROOT, out)}/  ` +
          `(@tm/sdk ${res.version}, ${res.stats.restPaths} REST routes, ${res.stats.mcpTools} MCP tools, ` +
          `${(res.stats.bytes / 1024).toFixed(0)} kB of context, ${(res.stats.zipBytes / 1024).toFixed(0)} kB plugin)`,
      );
    }
  } catch (e) {
    console.error(`\n\x1b[31mintegrate\x1b[0m │ ${e instanceof IntegrationError ? e.message : (e?.stack ?? e)}\n`);
    process.exit(1);
  }
}

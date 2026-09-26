// A workspace is a folder: workspace.json + .env + brief.md (spec §Z1).
// This reads one and says what is wrong with it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export const DEFAULTS = {
  enabled: true,
  maxAgents: 1,
  maxRunMin: 240,
  permissionMode: 'bypassPermissions',
  /** 'opus' — the best model at a cost that does not burn through the budget; fable is opt-in per workspace. */
  model: 'opus',
  autoResume: 3,
  /** Safety poll while streaming (ms); the poll interval when the wake stream is unavailable is pollMs / 20, floor 30 s. */
  pollMs: 600_000,
  claudeBin: path.join(os.homedir(), '.local/bin/claude'),
  stages: { todo: null, progress: null, review: null },
  env: {},
};

/** Parse KEY=value lines (quotes stripped, # comments ignored). */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

/** Every folder under the root with a workspace.json. */
export function listWorkspaces() {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'lib' && fs.existsSync(path.join(ROOT, d.name, 'workspace.json')))
    .map((d) => d.name)
    .sort();
}

/**
 * Load one workspace. Returns { name, dir, cfg, env, problems }. `problems`
 * is empty when it can run; the supervisor starts only those.
 */
export function loadWorkspace(name) {
  const dir = path.join(ROOT, name);
  const problems = [];
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
  } catch (e) {
    problems.push(`workspace.json: ${e.message}`);
  }
  const cfg = { ...DEFAULTS, ...raw, stages: { ...DEFAULTS.stages, ...(raw.stages ?? {}) }, env: { ...(raw.env ?? {}) } };
  cfg.name = name;
  cfg.dir = dir;
  if (!cfg.repo) problems.push('workspace.json: "repo" (the directory the agents work in) is required');
  else {
    cfg.repo = cfg.repo.replace(/^~(?=$|\/)/, os.homedir());
    if (!path.isAbsolute(cfg.repo)) cfg.repo = path.resolve(ROOT, cfg.repo);
    if (!fs.existsSync(cfg.repo)) problems.push(`repo does not exist: ${cfg.repo}`);
  }
  if (!cfg.board) problems.push('workspace.json: "board" (the board key, e.g. OCZ) is required');
  for (const k of ['maxAgents', 'maxRunMin', 'autoResume', 'pollMs']) if (!Number.isFinite(Number(cfg[k]))) problems.push(`workspace.json: "${k}" must be a number`);
  if (!['bypassPermissions', 'auto', 'acceptEdits', 'default', 'plan'].includes(cfg.permissionMode)) problems.push(`workspace.json: unknown permissionMode "${cfg.permissionMode}"`);
  if (!fs.existsSync(cfg.claudeBin)) problems.push(`claude binary not found: ${cfg.claudeBin}`);
  const envFile = path.join(dir, '.env');
  const env = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  if (!env.TM_TOKEN) problems.push('.env: TM_TOKEN is missing (a Worker token for this board, acting as the agent)');
  else if (!/^tm_live_/.test(env.TM_TOKEN)) problems.push('.env: TM_TOKEN does not look like a token (tm_live_…)');
  if (!fs.existsSync(path.join(dir, 'brief.md'))) problems.push('brief.md is missing (the project rules for an unattended agent; it may be short)');
  return { name, dir, cfg, env, problems };
}

/** workspaces/.env — what every workspace shares: TM_BASE (the app's origin) and the account token. */
export function rootEnv() {
  const f = path.join(ROOT, '.env');
  return fs.existsSync(f) ? parseEnv(fs.readFileSync(f, 'utf8')) : {};
}

/** The account token `ws new` creates boards and agents with. */
export function accountToken() {
  return rootEnv().TM_ACCOUNT_TOKEN ?? null;
}

// The REST client (tm.mjs) reads TM_BASE from the environment at import time.
// Every entry point imports this module first, so this is where the file's
// value lands in the environment when the shell did not set one.
if (!process.env.TM_BASE && rootEnv().TM_BASE) process.env.TM_BASE = rootEnv().TM_BASE;

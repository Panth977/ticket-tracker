#!/usr/bin/env node
// The workspaces CLI and supervisor (spec §Z1).
//
//   node ws.mjs up                 start the supervisor (detached); it runs one orch per enabled workspace
//   node ws.mjs down               stop the supervisor and every orch (running agents resume on the next up)
//   node ws.mjs status [ws]        what every orch is doing
//   node ws.mjs health             exit 1 when something is wrong
//   node ws.mjs logs <ws> [KEY]    the orch log, or an agent's run on a ticket
//   node ws.mjs restart <ws>       restart one orch (the supervisor does this by itself when its files change)
//   node ws.mjs validate [ws]      say what is wrong with a workspace, if anything
//   node ws.mjs new <name> --repo <dir> --board <KEY> --agent "<name>" [--template kanban] [--prompt <file>]
//                                  create the agent and the board (account token in workspaces/.env), write the folder
//   node ws.mjs install|uninstall  a launchd agent so `up` survives a reboot
//   node ws.mjs supervise          the supervisor itself, in the foreground

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountToken, listWorkspaces, loadWorkspace, ROOT } from './lib/config.mjs';
import { createTm } from './lib/tm.mjs';

const PID_FILE = path.join(ROOT, '.supervisor.pid');
const LOG_FILE = path.join(ROOT, '.supervisor.log');
const ORCH = path.join(ROOT, 'lib/orch.mjs');
const LAUNCHD_LABEL = 'com.taskmanager.workspaces';
const alive = (pid) => { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const readPid = (f) => (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const ago = (t) => (t ? `${Math.round((Date.now() - Date.parse(t)) / 1000)}s ago` : 'never');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { flags[rest[i].slice(2)] = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : true; }
  else positional.push(rest[i]);
}

// ─── the supervisor ─────────────────────────────────────────────────────────

async function supervise() {
  const other = readPid(PID_FILE);
  if (other && other !== process.pid && alive(other)) { console.error(`supervisor already running (pid ${other})`); process.exit(1); }
  fs.writeFileSync(PID_FILE, String(process.pid));
  const out = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  const log = (m) => { const line = `${new Date().toISOString()} ${m}`; out.write(line + '\n'); if (process.stdout.isTTY) console.log(line); };
  log(`supervisor up · pid ${process.pid}`);

  const children = new Map(); // name → { child, since, stopping }
  const crashes = new Map(); // name → consecutive crashes
  let stopping = false;

  function start(name) {
    if (children.has(name)) return;
    const w = loadWorkspace(name);
    if (!w.cfg.enabled) return;
    if (w.problems.length) { log(`${name}: not started — ${w.problems.join('; ')}`); return; }
    fs.mkdirSync(path.join(w.dir, 'logs'), { recursive: true });
    const orchOut = fs.openSync(path.join(w.dir, 'logs/orch.out'), 'a');
    const child = spawn(process.execPath, [ORCH, name], { cwd: ROOT, stdio: ['ignore', orchOut, orchOut], env: { ...process.env } });
    const rec = { child, since: Date.now(), stopping: false };
    children.set(name, rec);
    log(`${name}: orch started (pid ${child.pid})`);
    child.on('exit', (code, signal) => {
      fs.closeSync(orchOut);
      children.delete(name);
      if (stopping) return;
      const ranFor = Date.now() - rec.since;
      if (rec.stopping || signal === 'SIGTERM') {
        log(`${name}: orch stopped (${signal ?? code}); restarting`);
        setTimeout(() => start(name), 1000);
        return;
      }
      // A crash: back off, from 5 s to 5 min, reset by a run that lasted an hour.
      const n = ranFor > 3_600_000 ? 1 : (crashes.get(name) ?? 0) + 1;
      crashes.set(name, n);
      const wait = Math.min(300_000, 5_000 * 2 ** (n - 1));
      log(`${name}: orch exited (code ${code}${signal ? `, ${signal}` : ''}) after ${Math.round(ranFor / 1000)}s; restart in ${Math.round(wait / 1000)}s`);
      setTimeout(() => start(name), wait);
    });
  }

  function stop(name, why) {
    const rec = children.get(name);
    if (!rec) return Promise.resolve();
    rec.stopping = true;
    log(`${name}: stopping orch (${why})`);
    rec.child.kill('SIGTERM');
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { rec.child.kill('SIGKILL'); } catch { /* already gone */ } resolve(); }, 20_000);
      rec.child.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  function reconcile() {
    const wanted = new Set(listWorkspaces().filter((n) => { const w = loadWorkspace(n); return w.cfg.enabled && !w.problems.length; }));
    for (const name of children.keys()) if (!wanted.has(name)) void stop(name, 'disabled or removed');
    for (const name of wanted) start(name);
    for (const name of listWorkspaces()) {
      const w = loadWorkspace(name);
      if (w.cfg.enabled && w.problems.length && !children.has(name)) log(`${name}: waiting — ${w.problems.join('; ')}`);
    }
  }

  // Watch the tree: a workspace's own files restart it; lib/ restarts all.
  const pending = new Map();
  const runtimeFile = (f) => /(^|\/)(state|logs)(\/|$)/.test(f) || /\.(tmp|pid|log|out|jsonl)$/.test(f) || f.startsWith('.supervisor');
  let libTimer = null;
  const onChange = (f) => {
    if (!f || runtimeFile(f)) return;
    const [top] = f.split('/');
    if (top === 'lib' || top === 'ws.mjs') {
      clearTimeout(libTimer);
      libTimer = setTimeout(async () => {
        log('lib/ changed: restarting every orch');
        for (const name of [...children.keys()]) await stop(name, 'lib changed');
        reconcile();
      }, 2000);
      return;
    }
    if (!fs.existsSync(path.join(ROOT, top, 'workspace.json')) && !children.has(top)) return;
    clearTimeout(pending.get(top));
    pending.set(top, setTimeout(async () => {
      pending.delete(top);
      log(`${top}: ${f} changed`);
      if (children.has(top)) await stop(top, `${path.basename(f)} changed`);
      reconcile();
    }, 1500));
  };
  try {
    fs.watch(ROOT, { recursive: true }, (_ev, f) => onChange(f && String(f)));
  } catch (e) {
    log(`fs.watch failed (${e.message}); falling back to a 30 s scan`);
    setInterval(reconcile, 30_000);
  }

  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log(`supervisor stopping (${sig})`);
    await Promise.all([...children.keys()].map((n) => stop(n, sig)));
    fs.rmSync(PID_FILE, { force: true });
    log('supervisor stopped');
    out.end(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  reconcile();
  setInterval(reconcile, 300_000); // a workspace whose token arrived without a file event
}

// ─── commands ───────────────────────────────────────────────────────────────

function up() {
  const p = readPid(PID_FILE);
  if (alive(p)) { console.log(`supervisor already running (pid ${p})`); return; }
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'supervise'], { cwd: ROOT, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  console.log(`supervisor started (pid ${child.pid}) · log ${path.relative(process.cwd(), LOG_FILE)}`);
}

async function down() {
  const p = readPid(PID_FILE);
  if (!alive(p)) { console.log('supervisor is not running'); fs.rmSync(PID_FILE, { force: true }); return; }
  process.kill(p, 'SIGTERM');
  for (let i = 0; i < 60; i++) { if (!alive(p)) { console.log('supervisor stopped (running agents resume on the next up)'); return; } await sleep(500); }
  console.log('supervisor did not stop within 30 s'); process.exit(1);
}

function statusOf(name) {
  const w = loadWorkspace(name);
  const s = readJson(path.join(w.dir, 'state/status.json'));
  const pid = readPid(path.join(w.dir, 'state/orch.pid'));
  return { w, s, pid, running: alive(pid) };
}

function status() {
  const p = readPid(PID_FILE);
  console.log(alive(p) ? `supervisor: running (pid ${p})` : 'supervisor: NOT running');
  const names = positional[0] ? [positional[0]] : listWorkspaces();
  for (const name of names) {
    const { w, s, running } = statusOf(name);
    console.log(`\n▸ ${name} · board ${w.cfg.board} · ${w.cfg.repo}${w.cfg.enabled ? '' : ' · DISABLED'}`);
    if (w.problems.length) { for (const pr of w.problems) console.log(`  ! ${pr}`); continue; }
    console.log(`  orch: ${running ? `running (pid ${s?.pid})` : 'NOT running'}${s ? ` · ${s.me?.agent} (${s.me?.role}) · ${s.loops} loops · last ok ${ago(s.last_ok_at)}${s.last_error ? ` · last error: ${s.last_error.message}` : ''}` : ''}`);
    if (!s) continue;
    console.log(`  wake: ${s.wake?.source ?? '?'}${s.wake?.degraded ? ` (${s.wake.degraded})` : ''} · requests today ${s.requests_today?.count ?? 0}${s.rate_limited_until ? ` · RATE LIMITED until ${s.rate_limited_until}` : ''} · max ${s.config?.maxAgents} agent(s) · ${s.config?.permissionMode} · model ${s.config?.model ?? 'default'}`);
    for (const r of s.running ?? []) console.log(`  ▶ ${r.ticket}  pid ${r.pid}  since ${r.started_at}  output ${ago(r.last_output_at)}  ${r.last_beat ?? ''}`);
    for (const [k, e] of Object.entries(s.tickets ?? {})) if (!(s.running ?? []).some((r) => r.ticket === k)) console.log(`    ${k.padEnd(8)} ${String(e.phase).padEnd(8)} runs ${e.runs}${e.session_usd ? `  $${e.session_usd.toFixed(2)}` : ''}  ${(e.summary ?? '').slice(0, 100)}`);
  }
}

function health() {
  let bad = 0;
  const p = readPid(PID_FILE);
  if (alive(p)) console.log(`ok    supervisor alive (pid ${p})`); else { console.log('FAIL  supervisor not running'); bad = 1; }
  for (const name of listWorkspaces()) {
    const { w, s, running } = statusOf(name);
    if (!w.cfg.enabled) continue;
    if (w.problems.length) { console.log(`WARN  ${name}: ${w.problems.join('; ')}`); continue; }
    if (!running) { console.log(`FAIL  ${name}: orch not running`); bad = 1; continue; }
    const okAge = s?.last_ok_at ? (Date.now() - Date.parse(s.last_ok_at)) / 1000 : Infinity;
    const limit = (s?.wake?.source === 'stream' ? s.config.pollMs : Math.max(30_000, s.config.pollMs / 20)) / 1000 * 2 + 60;
    if (s?.rate_limited_until && Date.parse(s.rate_limited_until) > Date.now()) { console.log(`FAIL  ${name}: the tracker's daily budget is spent until ${s.rate_limited_until}`); bad = 1; }
    else if (okAge <= limit) console.log(`ok    ${name}: tracker reachable (last good tick ${Math.round(okAge)}s ago, wake via ${s.wake?.source})`);
    else { console.log(`FAIL  ${name}: no good tick for ${Math.round(okAge)}s${s?.last_error ? ` · ${s.last_error.message}` : ''}`); bad = 1; }
    for (const r of s?.running ?? []) {
      const quiet = (Date.now() - Date.parse(r.last_output_at ?? r.started_at)) / 1000;
      if (!alive(r.pid)) { console.log(`FAIL  ${name}/${r.ticket}: agent pid ${r.pid} is gone`); bad = 1; }
      else if (quiet > 900) console.log(`WARN  ${name}/${r.ticket}: agent silent for ${Math.round(quiet / 60)} min`);
      else console.log(`ok    ${name}/${r.ticket}: agent alive, output ${Math.round(quiet)}s ago`);
    }
    for (const [k, e] of Object.entries(s?.tickets ?? {})) if (e.phase === 'failed') console.log(`WARN  ${name}/${k} failed: ${e.summary} (move it to To do to retry)`);
  }
  console.log(bad ? 'UNHEALTHY' : 'healthy');
  process.exit(bad);
}

function logs() {
  const [name, key] = positional;
  if (!name) { console.error('usage: ws logs <workspace> [TICKET-KEY]'); process.exit(2); }
  const dir = path.join(ROOT, name);
  if (!key) { const f = path.join(dir, 'logs/orch.log'); console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').slice(-60).join('\n') : '(no log yet)'); return; }
  const runsDir = path.join(dir, 'logs/runs');
  const files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.startsWith(key + '-')).sort((a, b) => Number(a.split('-').at(-1).split('.')[0]) - Number(b.split('-').at(-1).split('.')[0])) : [];
  const f = files.at(-1);
  if (!f) { console.log(`no run log for ${key}`); process.exit(1); }
  console.log(`== ${path.join(runsDir, f)}`);
  // The agent's own words and tool calls, not the raw stream.
  for (const l of fs.readFileSync(path.join(runsDir, f), 'utf8').split('\n').filter(Boolean).slice(-400)) {
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.type === 'assistant') for (const c of m.message?.content ?? []) {
      if (c.type === 'text') console.log(`» ${c.text}`);
      if (c.type === 'tool_use') console.log(`  ⚙ ${c.name} ${JSON.stringify(c.input).slice(0, 160)}`);
    }
    if (m.type === 'stderr') console.log(`! ${m.text.trim()}`);
    if (m.type === 'result') console.log(`= ${m.subtype} · $${m.total_cost_usd?.toFixed(2)} session · ${JSON.stringify(m.structured_output ?? m.result).slice(0, 300)}`);
  }
}

async function restart() {
  const name = positional[0];
  if (!name) { console.error('usage: ws restart <workspace>'); process.exit(2); }
  const pid = readPid(path.join(ROOT, name, 'state/orch.pid'));
  if (!alive(pid)) { console.log(`${name}: orch not running (the supervisor starts it when its files are valid)`); return; }
  process.kill(pid, 'SIGTERM');
  console.log(`${name}: orch asked to stop (pid ${pid}); the supervisor restarts it`);
}

function validate() {
  const names = positional[0] ? [positional[0]] : listWorkspaces();
  let bad = 0;
  for (const name of names) {
    const w = loadWorkspace(name);
    if (w.problems.length) { bad++; console.log(`✗ ${name}\n    ${w.problems.join('\n    ')}`); }
    else console.log(`✓ ${name} · board ${w.cfg.board} · ${w.cfg.repo} · ${w.cfg.maxAgents} agent(s)${w.cfg.enabled ? '' : ' · disabled'}`);
  }
  process.exit(bad ? 1 : 0);
}

async function create() {
  const name = positional[0];
  const { repo, board, agent, template = 'kanban', prompt } = flags;
  if (!name || !repo || !board || !agent) {
    console.error('usage: ws new <name> --repo <dir> --board <KEY> --agent "<agent name>" [--template kanban|sprint|bugs] [--prompt <file.md>] [--description "…"]');
    process.exit(2);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) { console.error('the workspace name is a folder: lowercase letters, digits and dashes'); process.exit(2); }
  const dir = path.join(ROOT, name);
  if (fs.existsSync(dir)) { console.error(`${dir} already exists`); process.exit(2); }
  const repoDir = repo.replace(/^~(?=$|\/)/, os.homedir());
  if (!fs.existsSync(repoDir)) { console.error(`repo does not exist: ${repoDir}`); process.exit(2); }
  const token = accountToken();
  if (!token) { console.error(`No TM_ACCOUNT_TOKEN in ${path.join(ROOT, '.env')} — an account token (Account › Tokens › Account token, preset Full account) is what creates boards and agents.`); process.exit(2); }
  const tm = createTm({ token });
  const meRes = await tm.me();
  if (meRes.kind !== 'account') { console.error('TM_ACCOUNT_TOKEN is not an account token'); process.exit(2); }
  const systemPrompt = prompt ? fs.readFileSync(prompt, 'utf8') : `You are ${agent}, the agent that works tickets on the ${board} board for the project in ${repoDir}.`;
  console.log(`creating agent "${agent}"…`);
  const ag = await tm.createAgent({ name: agent, description: flags.description ?? `Works the ${board} board`, system_prompt: systemPrompt });
  const agentId = ag.id ?? ag.principal?.id;
  console.log(`  ${agentId}`);
  console.log(`creating board ${board} (${template})…`);
  const b = await tm.createBoard({ name: flags.name ?? board, key: board, template });
  console.log(`  ${b.url ?? b.id}`);
  console.log(`putting the agent on the board as an editor…`);
  await tm.setBoardAgent(board, { agent: agentId, role: 'editor' });
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({
    name, repo: repoDir, board, agent, agentId, enabled: true, maxAgents: 1, maxRunMin: 240,
    permissionMode: 'bypassPermissions', model: 'opus', autoResume: 3, env: {},
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'brief.md'), `Read this repository's CLAUDE.md and the memory it loads; all of it applies to you.\n\n(Add here the rules that bite an unattended agent in ${repoDir}: what never to run, which account to use, how to verify, whether the ticket may ship.)\n`);
  fs.writeFileSync(path.join(dir, '.env'), `# A Worker token for agent "${agent}" (${agentId}) on board ${board}: Account › Tokens › New token.\nTM_TOKEN=\n`, { mode: 0o600 });
  console.log(`\nwrote ${dir}/\n\nOne step is a person's: mint a token — Account › Tokens › New token · board ${board} · acts as ${agent} · preset Worker —\nand put it in ${path.join(dir, '.env')} as TM_TOKEN=tm_live_… The supervisor starts the orch the moment the file is valid.`);
}

function install() {
  const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${new URL(import.meta.url).pathname}</string><string>supervise</string></array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string><key>HOME</key><string>${os.homedir()}</string></dict>
</dict></plist>
`;
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, xml);
  console.log(`wrote ${plist}\nload it with:  launchctl bootstrap gui/$(id -u) ${plist}\n(run \`node ws.mjs down\` first if a supervisor started by \`up\` is running)`);
}
function uninstall() {
  const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  console.log(`launchctl bootout gui/$(id -u) ${plist}; rm ${plist}`);
}

const commands = { up, down, status, health, logs, restart, validate, new: create, install, uninstall, supervise };
if (!commands[cmd]) {
  console.log('usage: node ws.mjs up | down | status [ws] | health | logs <ws> [KEY] | restart <ws> | validate [ws] | new <name> --repo … --board … --agent … | install | uninstall | supervise');
  process.exit(cmd ? 2 : 0);
}
await commands[cmd]();

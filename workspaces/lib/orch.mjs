#!/usr/bin/env node
// The orch: ONE process per workspace (spec §Z1). It watches the workspace's
// board for tickets assigned to its token's agent and runs one headless
// Claude Code session per ticket in the workspace's repo.
//
//   To do  ──orch claims──▶ In progress ──agent reports "review"──▶ Review ──owner──▶ Done
//                               │  ▲
//              agent asks a     │  │ the answer (form or a comment) resumes
//              question ────────▼  │ the same session
//                             waiting
//
// Moving a ticket back to To do resumes its session as rework. Unassigning it,
// or moving it anywhere else while an agent runs, stops the agent.
//
// The orch owns the stage, the heartbeat, the event inbox and the TURN RECEIPT
// (§Y1: one message per run carrying what it cost). The agent gets the
// tracker's MCP tools for everything else. It wakes on the board's Realtime
// Database rev instead of polling (§W), and polls only where it cannot.
//
//   node lib/orch.mjs <workspace name>       (the supervisor does this)

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWorkspace, ROOT } from './config.mjs';
import { createTm, sleep, watch, BASE } from './tm.mjs';

const NAME = process.argv[2];
if (!NAME) { console.error('usage: node lib/orch.mjs <workspace>'); process.exit(2); }
const ws = loadWorkspace(NAME);
if (ws.problems.length) { console.error(`${NAME}: ` + ws.problems.join('\n' + ' '.repeat(NAME.length + 2))); process.exit(2); }
const CFG = ws.cfg;
const REPO = CFG.repo;
const STATE_DIR = path.join(ws.dir, 'state');
const LOG_DIR = path.join(ws.dir, 'logs');
const RUN_LOG_DIR = path.join(LOG_DIR, 'runs');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const STATUS_FILE = path.join(STATE_DIR, 'status.json');
const PID_FILE = path.join(STATE_DIR, 'orch.pid');
const MCP_FILE = path.join(STATE_DIR, 'mcp.json');
const STOP_FILE = path.join(STATE_DIR, 'stop');
for (const d of [STATE_DIR, LOG_DIR, RUN_LOG_DIR]) fs.mkdirSync(d, { recursive: true });

// ─── logging ────────────────────────────────────────────────────────────────

const logStream = fs.createWriteStream(path.join(LOG_DIR, 'orch.log'), { flags: 'a' });
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  logStream.write(line + '\n');
  if (process.stdout.isTTY) console.log(line);
}

// ─── single instance ────────────────────────────────────────────────────────

const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
{
  const other = Number(fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8'));
  if (other && other !== process.pid && alive(other)) { console.error(`${NAME}: orch is already running (pid ${other}).`); process.exit(1); }
  fs.writeFileSync(PID_FILE, String(process.pid));
  fs.rmSync(STOP_FILE, { force: true });
}

// ─── state ──────────────────────────────────────────────────────────────────
// tickets[KEY] = { phase, session_id, runs, pid, question_id, summary, updated_at,
//                  resumes, session_usd, session_usage, pending_review, answered, queued }
// phase: running | waiting | blocked | review | failed | stopped

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { tickets: {} };
state.tickets ??= {};
const saveState = () => {
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
};
const entry = (key) => (state.tickets[key] ??= { phase: null, session_id: null, runs: 0 });
const setPhase = (key, phase, extra = {}) => {
  Object.assign(entry(key), { phase, ...extra, updated_at: new Date().toISOString() });
  saveState();
};

const status = {
  workspace: NAME,
  pid: process.pid,
  started_at: new Date().toISOString(),
  last_loop_at: null,
  last_ok_at: null,
  last_error: null,
  loops: 0,
  wake: null,
  config: { repo: REPO, board: CFG.board, maxAgents: CFG.maxAgents, maxRunMin: CFG.maxRunMin, permissionMode: CFG.permissionMode, model: CFG.model, autoResume: CFG.autoResume, pollMs: CFG.pollMs, claude: CFG.claudeBin, token: ws.env.TM_TOKEN.slice(0, 12) + '…' },
};
function writeStatus() {
  status.running = [...runs.values()].map((r) => ({
    ticket: r.key, pid: r.child.pid, session_id: r.sessionId, started_at: r.startedAt,
    last_output_at: r.lastOutputAt, last_beat: r.lastBeat, log: path.relative(ws.dir, r.logPath),
  }));
  status.tickets = state.tickets;
  status.wake = watcher ? { source: watcher.state.source, degraded: watcher.state.degraded, paths: watcher.state.paths } : null;
  fs.writeFileSync(STATUS_FILE + '.tmp', JSON.stringify(status, null, 2));
  fs.renameSync(STATUS_FILE + '.tmp', STATUS_FILE);
}

// ─── the tracker ────────────────────────────────────────────────────────────

const tm = createTm({ token: ws.env.TM_TOKEN, log });
// Started while the day's budget is spent: wait for it instead of dying.
async function untilServed(call) {
  for (;;) {
    try { return await call(); } catch (e) {
      if (e.code !== 'rate_limited') throw e;
      log(`startup: ${e.message}, waiting`);
      await sleep(Math.max(tm.budget.limitedUntil - Date.now(), 60_000));
    }
  }
}
const me = await untilServed(() => tm.me());
if (!me.board) { console.error(`${NAME}: the token is not a board token (kind ${me.kind}). Use a board token acting as the agent.`); process.exit(2); }
if (me.board.key !== CFG.board) { console.error(`${NAME}: workspace.json says board ${CFG.board} but the token is for ${me.board.key}.`); process.exit(2); }
const board = await untilServed(() => tm.board());
const byName = (want) => want && board.stages.find((s) => s.name.toLowerCase() === String(want).toLowerCase());
const stages = {
  todo: byName(CFG.stages.todo) ?? board.stages.find((s) => s.category === 'todo'),
  progress: byName(CFG.stages.progress) ?? board.stages.find((s) => /in.?progress/i.test(s.name)) ?? board.stages.find((s) => s.category === 'active'),
  review: byName(CFG.stages.review) ?? board.stages.find((s) => /review/i.test(s.name)),
};
if (!stages.todo || !stages.progress || !stages.review) {
  console.error(`${NAME}: the board needs a To do, an In progress and a Review stage (or name them in workspace.json "stages").`, board.stages.map((s) => s.name));
  process.exit(2);
}
status.me = { agent: me.principal.name, id: me.principal.id, board: me.board.key, role: me.role };
log(`orch up · ${NAME} · pid ${process.pid} · ${me.principal.name} (${me.role}) on ${me.board.key} · ${REPO} · max ${CFG.maxAgents} agent(s)`);

// The agent reaches the tracker through the same token, over MCP.
fs.writeFileSync(MCP_FILE, JSON.stringify({
  mcpServers: { tm: { type: 'http', url: `${BASE}/mcp`, headers: { Authorization: `Bearer ${ws.env.TM_TOKEN}` } } },
}, null, 2), { mode: 0o600 });

// ─── agents ─────────────────────────────────────────────────────────────────

const OUTCOME_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['review', 'waiting', 'blocked'] },
    summary: { type: 'string' },
    question_id: { type: 'string' },
  },
  required: ['status', 'summary'],
});
// What only the orch may do: the stage, the heartbeat, the inbox, assignment.
const DISALLOWED = ['move_ticket', 'update_ticket', 'assign_ticket', 'create_ticket', 'heartbeat', 'get_events', 'ack_events']
  .map((t) => `mcp__tm__${t}`).join(',');

let watcher = null; // the wake stream, opened once the tracker is known
const runs = new Map(); // key → { key, child, sessionId, startedAt, logPath, lastOutputAt, result, stopReason }

const sessionFile = (id) =>
  path.join(os.homedir(), '.claude/projects', REPO.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);

function brief(key) {
  const own = fs.existsSync(path.join(ws.dir, 'brief.md')) ? fs.readFileSync(path.join(ws.dir, 'brief.md'), 'utf8').trim() : '(nothing beyond the project\'s own CLAUDE.md)';
  const text = fs.readFileSync(path.join(ROOT, 'lib/brief.md'), 'utf8')
    .replaceAll('{{KEY}}', key)
    .replaceAll('{{WORKSPACE}}', NAME)
    .replaceAll('{{REPO}}', REPO)
    .replaceAll('{{AGENT}}', me.principal.name)
    .replaceAll('{{MAX_AGENTS}}', String(CFG.maxAgents))
    .replaceAll('{{BOARD}}', `${me.board.key} · ${me.board.name}`)
    .replaceAll('{{SYSTEM_PROMPT}}', me.principal.system_prompt ?? '(none)')
    .replaceAll('{{WORKSPACE_BRIEF}}', own);
  const file = path.join(STATE_DIR, `brief-${key}.md`);
  fs.writeFileSync(file, text);
  return file;
}

function startAgent(key, prompt) {
  const e = entry(key);
  const resume = e.session_id && fs.existsSync(sessionFile(e.session_id));
  const sessionId = resume ? e.session_id : randomUUID();
  if (!resume) { e.session_usd = 0; e.session_usage = null; } // a new session starts its cost from zero
  e.runs = (e.runs ?? 0) + 1;
  const logPath = path.join(RUN_LOG_DIR, `${key}-${e.runs}.jsonl`);
  const out = fs.createWriteStream(logPath, { flags: 'a' });

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--json-schema', OUTCOME_SCHEMA,
    '--permission-mode', CFG.permissionMode,
    '--mcp-config', MCP_FILE,
    '--append-system-prompt-file', brief(key),
    '--name', `orch ${key}`,
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ...(CFG.model ? ['--model', CFG.model] : []),
    // Headless, auto mode refuses MCP tools it has not been told about.
    '--allowedTools=mcp__tm',
    `--disallowedTools=${DISALLOWED}`,
  ];
  const env = { ...process.env, ...CFG.env, ...ws.env };
  delete env.TM_TOKEN; // the token reaches the agent only through mcp.json
  delete env.TM_ACCOUNT_TOKEN;
  // detached: its own process group, so a stop takes its tool subprocesses with it.
  const child = spawn(CFG.claudeBin, args, { cwd: REPO, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

  const run = { key, child, sessionId, startedAt: new Date().toISOString(), logPath, lastOutputAt: null, lastBeat: null, lastProgress: null, result: null, stopReason: null };
  runs.set(key, run);
  setPhase(key, 'running', { session_id: sessionId, pid: child.pid, question_id: null });
  log(`${key} · agent started · pid ${child.pid} · ${resume ? 'resumed' : 'new'} session ${sessionId} · run ${e.runs}`);

  let buf = '';
  child.stdout.on('data', (chunk) => {
    out.write(chunk);
    run.lastOutputAt = new Date().toISOString();
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.includes('"type":"result"')) continue;
      try { run.result = JSON.parse(line); } catch { /* a partial line */ }
    }
  });
  child.stderr.on('data', (chunk) => out.write(JSON.stringify({ type: 'stderr', text: String(chunk) }) + '\n'));

  // The heartbeat is the orch's job: the ticket's dot shows the task list's progress.
  let beats = 0;
  const beat = async () => {
    if (tm.budget.limitedUntil > Date.now()) return;
    try {
      // A beat a minute is the budget; the task list is re-read every fifth.
      if (beats++ % 5 && run.lastBeat) return await tm.beat(key, 'working', run.lastBeat, run.lastProgress);
      const lists = (await tm.tasklists(key)).data.filter((l) => l.owner?.id === me.principal.id && !l.closed_at);
      const list = lists.at(-1);
      let message = 'Working';
      let progress = null;
      if (list) {
        const doing = list.items.find((i) => i.status === 'doing');
        message = doing ? `${list.progress.done}/${list.progress.total} · ${doing.title}` : `${list.progress.done}/${list.progress.total} done`;
        progress = list.progress.total ? list.progress.done / list.progress.total : null;
      }
      run.lastBeat = message;
      run.lastProgress = progress;
      await tm.beat(key, 'working', message, progress);
    } catch (e) {
      log(`${key} · heartbeat failed: ${e.message}`);
    }
  };
  beat();
  const beatTimer = setInterval(beat, 60_000);
  const deadline = setTimeout(() => stopAgent(key, 'timeout'), CFG.maxRunMin * 60_000);

  child.on('exit', async (code, signal) => {
    clearInterval(beatTimer);
    clearTimeout(deadline);
    out.end();
    // Stays in `runs` until the outcome is written, so a tick in between
    // cannot mistake it for a crashed run and resume it.
    try {
      await finish(run, code, signal);
    } catch (e) {
      log(`${key} · finishing failed: ${e.stack ?? e}`);
      setPhase(key, 'failed', { pid: null, summary: `finishing failed: ${e.message}` });
    } finally {
      runs.delete(key);
      writeStatus();
      wake.push('agent-exit');
    }
  });
  writeStatus();
}

function stopAgent(key, reason) {
  const run = runs.get(key);
  if (!run) return;
  run.stopReason = reason;
  log(`${key} · stopping agent (${reason})`);
  killGroup(run.child.pid, 'SIGTERM');
  setTimeout(() => runs.has(key) && killGroup(run.child.pid, 'SIGKILL'), 10_000);
}

function killGroup(pid, sig) {
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* already gone */ } }
}

// ─── the turn receipt (§Y1) ─────────────────────────────────────────────────

const fmtUsd = (n) => (n < 10 ? `$${n.toFixed(2)}` : n < 100 ? `$${n.toFixed(1)}` : `$${Math.round(n)}`);
const fmtMin = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/**
 * Claude Code reports total_cost_usd CUMULATIVELY across a resumed session
 * (OCZ-5 run 8: one API turn, the same $392.83 as run 7). The receipt is the
 * difference from the last total this ticket's session reported. A run that
 * died without a result line leaves no receipt; its money lands in the next
 * difference, which is honest — it was spent on this ticket.
 */
async function receipt(run, outcome) {
  const r = run.result;
  if (!r || typeof r.total_cost_usd !== 'number') return;
  const e = entry(run.key);
  const prevUsd = e.session_usd ?? 0;
  const costUsd = Math.max(0, r.total_cost_usd - prevUsd);
  const u = r.usage ?? {};
  const now = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0 };
  const prev = e.session_usage ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const usage = Object.fromEntries(Object.keys(now).map((k) => [k, Math.max(0, now[k] - prev[k])]));
  const models = Object.entries(r.modelUsage ?? {}).sort((a, b) => (b[1].costUSD ?? 0) - (a[1].costUSD ?? 0));
  const model = models[0]?.[0] ?? null;
  e.session_usd = r.total_cost_usd;
  e.session_usage = now;
  saveState();
  const durationMs = Math.max(0, Date.now() - Date.parse(run.startedAt));
  const body = `**Turn ${e.runs}** · ${outcome} · ${fmtUsd(costUsd)} · ${fmtMin(durationMs)}${r.num_turns ? ` · ${r.num_turns} calls` : ''}${model ? ` · ${model.replace(/^claude-/, '')}` : ''}`;
  const runField = {
    n: e.runs, outcome, cost_usd: costUsd, session_usd: r.total_cost_usd, duration_ms: durationMs,
    api_turns: r.num_turns ?? null, model, usage,
  };
  try {
    await tm.post(run.key, body, `${run.key}:receipt:${e.runs}`, { run: runField });
  } catch (err) {
    log(`${run.key} · receipt failed (${err.message}): ${body}`);
  }
}

async function finish(run, code, signal) {
  const { key } = run;
  const outcome = run.result?.structured_output;
  const cost = run.result?.total_cost_usd != null ? ` · session $${run.result.total_cost_usd.toFixed(2)}` : '';
  log(`${key} · agent exited · code ${code} ${signal ?? ''}${cost} · ${outcome ? `${outcome.status}: ${outcome.summary}` : 'no outcome'}`);

  if (run.stopReason === 'shutdown') return; // stays 'running': the next orch resumes it
  if (run.stopReason === 'timeout') {
    setPhase(key, 'failed', { pid: null, summary: `Stopped after ${CFG.maxRunMin} minutes` });
    await receipt(run, 'timeout');
    await tm.post(key, `**The agent ran out of time** (${CFG.maxRunMin} min) and was stopped. Move this back to **To do** to let it carry on.`, `${key}:timeout:${entry(key).runs}`).catch(() => {});
    await tm.beat(key, 'error', 'Timed out').catch(() => {});
    return;
  }
  if (run.stopReason) {
    setPhase(key, 'stopped', { pid: null, summary: run.stopReason });
    await receipt(run, 'stopped');
    await tm.beat(key, 'idle', `Stopped: ${run.stopReason}`).catch(() => {});
    return;
  }

  needTickets = true; // a slot is free: look for queued work
  if (outcome?.status === 'review') {
    await receipt(run, 'review');
    // A move refused now (the day's budget) is retried by the next tick.
    await tm.move(key, stages.review.id, `${key}:review:${entry(key).runs}`)
      .then(() => delete entry(key).pending_review)
      .catch((e) => { entry(key).pending_review = true; log(`${key} · move to Review failed (${e.message}), will retry`); });
    await tm.beat(key, 'done', 'Ready for review').catch(() => {});
    // A run that got somewhere earns the ticket its auto-resumes back.
    setPhase(key, 'review', { pid: null, summary: outcome.summary, resumes: 0 });
  } else if (outcome?.status === 'waiting') {
    await receipt(run, 'waiting');
    await tm.beat(key, 'idle', 'Waiting for an answer').catch(() => {});
    setPhase(key, 'waiting', { pid: null, summary: outcome.summary, question_id: outcome.question_id ?? null });
  } else if (outcome?.status === 'blocked') {
    await receipt(run, 'blocked');
    const used = entry(key).resumes ?? 0;
    const more = used < CFG.autoResume;
    await tm.beat(key, 'idle', more ? 'Carrying on' : 'Blocked, see the thread').catch(() => {});
    setPhase(key, 'blocked', { pid: null, summary: outcome.summary });
    if (!more) {
      // Out of its own rope: say so once, on the ticket.
      await tm.post(key, `**I have stopped after ${used} automatic continuations.** The last one said:\n\n> ${outcome.summary}\n\nMove this back to **To do** to carry on, or answer whatever it is waiting for.`, `${key}:exhausted:${entry(key).runs}`).catch(() => {});
    }
  } else {
    const why = run.result?.is_error ? (run.result.subtype ?? 'error') : `exit ${code ?? signal}`;
    setPhase(key, 'failed', { pid: null, summary: why });
    await receipt(run, 'failed');
    await tm.post(key, `**The agent stopped without finishing** (${why}). The log is \`workspaces/${NAME}/${path.relative(ws.dir, run.logPath)}\`. Move this back to **To do** to retry.`, `${key}:failed:${entry(key).runs}`).catch(() => {});
    await tm.beat(key, 'error', `Agent failed: ${why}`).catch(() => {});
  }
}

// ─── prompts ────────────────────────────────────────────────────────────────

const P = {
  fresh: (t) => `Work ticket ${t.key}: "${t.title}". Start by reading it with get_ticket (messages: 50).`,
  rework: (t) => `The owner moved ${t.key} back to To do. Read the thread with get_messages for everything since your last report, then do the rework. Reopen or extend your task list and don't make a second one. Finish the way the brief says.`,
  recover: (t) => `The orch restarted while you were working on ${t.key}. Check your task list on the ticket and the working tree, then carry on from where you stopped.`,
  carryOn: (t, e) => `Your last turn on ${t.key} ended before the work did. You reported:\n\n> ${e.summary ?? '(no summary)'}\n\nNothing has changed since; the working tree and your task list are as you left them. Check the list and the tree, then carry on from there and finish the way the brief says.`,
  answered: (t, q) => `The owner answered your question "${q.title}" on ${t.key}.\n\nValues: ${JSON.stringify(q.answer?.values ?? q.values ?? {})}${(q.answer?.comment ?? q.comment) ? `\nComment: ${q.answer?.comment ?? q.comment}` : ''}\n\nCarry on with the work.`,
  cancelled: (t, q) => `Your question "${q.title}" on ${t.key} was ${q.status}. Read the thread in case the owner replied there, then either go ahead with the most conservative option or ask again.`,
  comment: (t, lines) => `There are new messages in the ${t.key} thread since you stopped:\n\n${lines.join('\n')}\n\nRead them in full with get_messages, then carry on.`,
};

// ─── the loop ───────────────────────────────────────────────────────────────

const pendingComments = new Map(); // key → [summary lines] from humans, not yet handed to a session
let needTickets = true;
let ticketsAt = 0;

async function drainEvents() {
  let n = 0;
  for (let page = 0; page < 5; page++) {
    const res = await tm.events();
    if (!res.data.length) return n;
    n += res.data.length;
    for (const ev of res.data) {
      const key = ev.ticket_key;
      if (!key) continue;
      const fromHuman = ev.actor && ev.actor.id !== me.principal.id && ev.actor.kind !== 'agent';
      if ((ev.type === 'comment' || ev.type === 'mentioned') && fromHuman) {
        if (!pendingComments.has(key)) pendingComments.set(key, []);
        pendingComments.get(key).push(`- ${ev.actor.name ?? 'someone'}: ${ev.summary}`);
      }
      if ((ev.type === 'question_answered' || ev.type === 'question_cancelled') && ev.question) {
        const e = state.tickets[key];
        if (e && ['waiting', 'blocked'].includes(e.phase)) e.answered = ev.question;
      }
    }
    await tm.ack(res.data.map((e) => e.id));
    if (!res.has_more) return n;
  }
  return n;
}

async function tick(reason) {
  // Moves, assignments, answers and comments all arrive as events, so the
  // ticket list is only re-read when something happened (or every 10 min).
  const events = await drainEvents();
  const boardMoved = reason === 'board' || reason === 'open';
  if (!events && !needTickets && !boardMoved && Date.now() - ticketsAt < 600_000) return;
  needTickets = false;
  const tickets = await tm.myTickets();
  ticketsAt = Date.now();
  for (const t of tickets) {
    const e = state.tickets[t.key];
    if (e?.pending_review && t.stage.id === stages.progress.id) {
      await tm.move(t.key, stages.review.id, `${t.key}:review:${e.runs}`);
      log(`${t.key} · moved to Review (retried)`);
      delete e.pending_review;
    }
  }
  const byKey = new Map(tickets.map((t) => [t.key, t]));

  // An agent whose ticket was unassigned, or moved away from In progress, stops.
  for (const key of runs.keys()) {
    const t = byKey.get(key);
    if (!t) stopAgent(key, 'unassigned');
    else if (t.stage.id !== stages.progress.id) stopAgent(key, `moved to ${t.stage.name}`);
  }

  // A ticket that is finished, or no longer ours, is forgotten.
  for (const key of Object.keys(state.tickets)) {
    if (runs.has(key)) continue;
    const t = byKey.get(key);
    if (!t || ['done', 'cancelled'].includes(t.stage.category)) {
      log(`${key} · ${t ? `reached ${t.stage.name}` : 'no longer assigned'}, forgetting it`);
      delete state.tickets[key];
      saveState();
    }
  }

  const free = () => runs.size < CFG.maxAgents;

  for (const t of tickets) {
    const key = t.key;
    const e = state.tickets[key];
    if (runs.has(key)) continue;

    // Waiting on the owner: an answer, or a comment in the thread, resumes the session.
    if (e && ['waiting', 'blocked'].includes(e.phase) && t.stage.id === stages.progress.id) {
      if (!e.answered && e.question_id && status.loops % 4 === 0) {
        const q = await tm.question(e.question_id).catch(() => null);
        if (q && q.status !== 'open') e.answered = q;
      }
      if (!free()) {
        // Say so, or a ticket whose answer has arrived looks ignored.
        if ((e.answered || pendingComments.has(key)) && !e.queued) {
          e.queued = true;
          await tm.beat(key, 'idle', 'Got your reply · queued until an agent is free').catch(() => {});
        }
        continue;
      }
      delete e.queued;
      if (e.answered) {
        const q = e.answered;
        delete e.answered;
        e.resumes = 0; // an answer is progress
        startAgent(key, q.status === 'answered' ? P.answered(t, q) : P.cancelled(t, q));
      } else if (pendingComments.has(key)) {
        e.resumes = 0; // so is the owner saying something
        startAgent(key, P.comment(t, pendingComments.get(key)));
        pendingComments.delete(key);
      } else if (e.phase === 'blocked' && (e.resumes ?? 0) < CFG.autoResume) {
        // Ran out of room, not out of answers: `waiting` is the status that
        // means a person is needed; `blocked` on a long ticket almost always
        // means the turn ended. Carry on, bounded.
        e.resumes = (e.resumes ?? 0) + 1;
        log(`${key} · carrying on by itself (${e.resumes}/${CFG.autoResume})`);
        startAgent(key, P.carryOn(t, e));
      }
      continue;
    }

    // The orch died mid-run: resume where it stopped.
    if (e?.phase === 'running' && t.stage.id === stages.progress.id) {
      if (!free()) continue;
      if (alive(e.pid)) killGroup(e.pid, 'SIGTERM'); // an orphan from a hard kill
      startAgent(key, P.recover(t));
      continue;
    }

    // To do: claim it and start (or resume, for rework).
    if (t.stage.id === stages.todo.id) {
      if (!free()) continue;
      await tm.move(key, stages.progress.id, `${key}:claim:${(e?.runs ?? 0) + 1}`);
      log(`${key} · claimed "${t.title}" → ${stages.progress.name}`);
      startAgent(key, e?.session_id ? P.rework(t) : P.fresh(t));
    }
  }
  // Comments only matter to a session that is waiting for the owner.
  for (const key of pendingComments.keys()) {
    if (runs.has(key) || !['waiting', 'blocked'].includes(state.tickets[key]?.phase)) pendingComments.delete(key);
  }
  saveState();
}

// ─── waking ─────────────────────────────────────────────────────────────────
// One slot: a burst of bumps while a tick runs is still one more tick.

const wake = {
  pending: null,
  waiter: null,
  push(reason) {
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(reason); }
    else this.pending ??= reason;
  },
  wait(ms) {
    if (this.pending) { const r = this.pending; this.pending = null; return Promise.resolve(r); }
    return new Promise((resolve) => {
      const t = setTimeout(() => { if (this.waiter === resolve) this.waiter = null; resolve('poll'); }, ms);
      this.waiter = (r) => { clearTimeout(t); resolve(r); };
    });
  },
};
watcher = watch({ tm, log, onWake: (p) => wake.push(/^rev\//.test(p) ? 'board' : 'inbox') });

// ─── shutdown ───────────────────────────────────────────────────────────────

let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log(`orch stopping (${sig}) · ${runs.size} agent(s) running`);
  watcher.stop();
  for (const key of runs.keys()) stopAgent(key, 'shutdown');
  const until = Date.now() + 12_000;
  while (runs.size && Date.now() < until) await sleep(200);
  for (const e of Object.values(state.tickets)) if (e.phase === 'running') e.pid = null;
  saveState();
  await tm.beat(null, 'idle', 'Orch stopped').catch(() => {});
  fs.rmSync(PID_FILE, { force: true });
  status.stopped_at = new Date().toISOString();
  writeStatus();
  log('orch stopped');
  logStream.end(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log(`unhandled: ${e?.stack ?? e}`));

let reason = 'open';
while (!stopping) {
  status.loops++;
  status.last_loop_at = new Date().toISOString();
  const limited = tm.budget.limitedUntil > Date.now();
  status.rate_limited_until = limited ? new Date(tm.budget.limitedUntil).toISOString() : null;
  status.requests_today = { day: tm.budget.day, count: tm.budget.count };
  if (limited) {
    // Agents keep working; only the tracker waits.
  } else try {
    await tick(reason);
    status.last_ok_at = new Date().toISOString();
    status.last_error = null;
  } catch (e) {
    status.last_error = { at: new Date().toISOString(), message: e.message, code: e.code ?? null };
    log(`tick failed: ${e.message}`);
    if (e.code === 'unauthenticated') {
      log('the token was refused (revoked or expired). Stopping.');
      await shutdown('unauthenticated');
    }
  }
  writeStatus();
  // Streaming: sleep until the board moves, with a safety poll. Polling: a
  // twentieth of that, never under 30 s.
  const streaming = watcher.state.source === 'stream';
  const waitMs = limited ? 60_000 : streaming ? CFG.pollMs : Math.max(30_000, Math.round(CFG.pollMs / 20));
  const until = Date.now() + waitMs;
  reason = 'poll';
  while (!stopping && Date.now() < until) {
    if (fs.existsSync(STOP_FILE)) { await shutdown('stop file'); break; }
    const r = await wake.wait(Math.min(1000, until - Date.now()));
    if (r !== 'poll') { reason = r; break; }
  }
}

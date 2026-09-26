// A thin REST client for the TaskManager /v1 API — plain fetch, no
// dependencies (decision D-Z2). The retry rules of llms-full.txt §6.2: 429
// waits for Retry-After, 5xx and network errors back off, everything else
// throws at once. Every write carries an idempotency key.
//
// Also here: the wake stream (spec §Z1). `watch()` opens the Realtime
// Database SSE stream that GET /v1/live hands out and resolves a waiter when
// the board's rev (or the agent's wake node) moves. Where /v1/live is not
// available it degrades to polling and says so.

import { randomUUID } from 'node:crypto';

// The app's origin: TM_BASE in workspaces/.env (or the environment), e.g. https://<your-project-id>.web.app
export const BASE = (process.env.TM_BASE ?? 'https://taskmanager-example.web.app').replace(/\/+$/, '');

export class TmError extends Error {
  constructor(problem, status) {
    super(problem.detail ?? problem.title ?? `HTTP ${status}`);
    this.code = problem.code;
    this.status = status;
    this.problem = problem;
  }
}

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });

export function createTm({ token, base = BASE + '/v1', log = () => {} }) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  // The token's budget is 60 a minute and 10 000 a day (§6.3). A Retry-After
  // longer than a minute is the daily cap: waiting inside one request would
  // hang the orch for hours, so every call fails fast until it lifts.
  const budget = { limitedUntil: 0, day: null, count: 0 };

  async function api(method, path, body, idempotencyKey) {
    if (Date.now() < budget.limitedUntil) {
      throw new TmError({ code: 'rate_limited', title: `Rate limited until ${new Date(budget.limitedUntil).toISOString()}` }, 429);
    }
    const write = method !== 'GET';
    const key = write ? (idempotencyKey ?? randomUUID()) : undefined;
    for (let attempt = 0; ; attempt++) {
      let res;
      const day = new Date().toISOString().slice(0, 10);
      if (budget.day !== day) Object.assign(budget, { day, count: 0 });
      budget.count++;
      try {
        res = await fetch(base + path, {
          method,
          headers: key ? { ...headers, 'Idempotency-Key': key } : headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        if (attempt >= 4) throw e;
        await sleep(2 ** attempt * 500 + Math.random() * 250);
        continue;
      }
      if (res.ok) return res.status === 204 ? null : res.json();
      const problem = await res.json().catch(() => ({ code: 'internal', title: res.statusText }));
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 4) throw new TmError(problem, res.status);
      const after = Number(res.headers.get('retry-after')) * 1000;
      if (res.status === 429 && after > 60_000) {
        budget.limitedUntil = Date.now() + after;
        throw new TmError(problem, res.status);
      }
      log(`tm ${method} ${path} → ${res.status}, retrying`);
      await sleep(after || 2 ** attempt * 500 + Math.random() * 250);
    }
  }

  const k = (key) => encodeURIComponent(key);

  return {
    api,
    budget,
    me: () => api('GET', '/me'),
    board: (key) => api('GET', key ? `/boards/${k(key)}` : '/board'),
    async myTickets() {
      const out = [];
      let cursor = null;
      do {
        const page = await api('GET', `/tickets?assignee=me&state=active&limit=200${cursor ? `&cursor=${cursor}` : ''}`);
        out.push(...page.data);
        cursor = page.next_cursor;
      } while (cursor);
      return out;
    },
    ticket: (key, messages = 0) => api('GET', `/tickets/${k(key)}?messages=${messages}`),
    move: (key, stage, idem) => api('POST', `/tickets/${k(key)}/move`, { stage }, idem),
    post: (key, markdown, idem, extra = {}) =>
      api('POST', `/tickets/${k(key)}/messages`, { body_markdown: markdown, ...extra }, idem),
    messages: (key, limit = 50) => api('GET', `/tickets/${k(key)}/messages?order=desc&limit=${limit}`),
    tasklists: (key) => api('GET', `/tickets/${k(key)}/tasklists`),
    question: (id) => api('GET', `/questions/${encodeURIComponent(id)}`),
    beat: (ticket, state, message, progress) =>
      api('POST', '/heartbeat', { ticket, state, message: message?.slice(0, 200) ?? null, progress: progress ?? null }),
    events: (cursor) => api('GET', `/events?limit=100&unacked=1${cursor ? `&cursor=${cursor}` : ''}`),
    ack: (ids) => api('POST', '/events/ack', { ids }),
    live: () => api('GET', '/live'),
    // Account-token only (spec §Z2).
    createAgent: (body) => api('POST', '/agents', body),
    createBoard: (body) => api('POST', '/boards', body),
    setBoardAgent: (key, body) => api('POST', `/boards/${k(key)}/agents`, body),
  };
}

// ─── SSE, parsed by hand (EventSource is not in Node and cannot send headers) ──

async function* readSse(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut).replace(/^(\r?\n){2}/, '');
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

function parseFrame(raw) {
  if (!raw.trim()) return null;
  const f = { event: 'message', id: null, data: [] };
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') f.event = value;
    else if (field === 'id') f.id = value;
    else if (field === 'data') f.data.push(value);
  }
  return { ...f, data: f.data.join('\n') };
}

/** The `at` a put/patch carries (the newest child's, at a parent), or null. */
function revisionOf(data) {
  if (typeof data === 'number') return Number.isFinite(data) ? data : null;
  if (!data || typeof data !== 'object') return null;
  if (typeof data.at === 'number') return data.at;
  let best = null;
  for (const child of Object.values(data)) {
    const n = revisionOf(child);
    if (n !== null && (best === null || n > best)) best = n;
  }
  return best;
}

/**
 * watch({ tm, log, onWake }) — hold one RTDB stream per path GET /v1/live
 * names; call onWake(reason) whenever a node's timestamp moves. Re-mints the
 * credential when it expires or the stream is refused. `state.source` says
 * whether it is streaming ('stream') or the caller must poll ('poll').
 */
export function watch({ tm, log, onWake }) {
  const state = { source: 'poll', degraded: 'starting', paths: [], stopped: false };
  const ctrl = new AbortController();
  let refusals = 0;

  (async () => {
    while (!state.stopped) {
      let cred;
      try {
        cred = await tm.live();
      } catch (e) {
        state.source = 'poll';
        state.degraded = `no live credential (${e.code ?? e.message})`;
        if (refusals++ === 0) log(`watch: ${state.degraded} — polling instead`);
        // A missing route stays missing for a while; a network blip does not.
        try { await sleep(e.status === 404 ? 30 * 60_000 : 60_000, ctrl.signal); } catch { return; }
        continue;
      }
      state.paths = cred.paths ?? [];
      if (!state.paths.length) { state.degraded = 'nothing to watch'; state.source = 'poll'; return; }
      // Each credential gets its own abort scope, so re-minting closes its streams.
      const scope = new AbortController();
      const stopScope = () => scope.abort(new Error('stopped'));
      ctrl.signal.addEventListener('abort', stopScope, { once: true });
      const ttl = Math.max(60_000, ((cred.expires_in ?? 3600) - 120) * 1000);
      state.source = 'stream';
      state.degraded = null;
      log(`watch: streaming ${state.paths.join(', ')} (credential for ${Math.round(ttl / 60000)} min)`);
      const one = (path) => streamOne(cred, path, scope, state, log, onWake);
      await Promise.race([Promise.all(state.paths.map(one)), sleep(ttl, scope.signal).catch(() => {})]);
      ctrl.signal.removeEventListener('abort', stopScope);
      scope.abort(new Error('re-mint'));
    }
  })();

  return { state, stop: () => { state.stopped = true; ctrl.abort(new Error('stopped')); } };
}

async function streamOne(cred, path, scope, state, log, onWake) {
  const origin = cred.database_url.replace(/\/+$/, '');
  let seen = -1;
  let retry = 500;
  while (!scope.signal.aborted) {
    try {
      const url = `${origin}/${path}.json${cred.auth ? `?auth=${encodeURIComponent(cred.auth)}` : ''}`;
      const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: scope.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      state.source = 'stream';
      state.degraded = null;
      retry = 500;
      for await (const frame of readSse(res.body, scope.signal)) {
        if (frame.event === 'keep-alive') continue;
        if (frame.event === 'auth_revoked' || frame.event === 'cancel') throw new Error(frame.event);
        if (frame.event !== 'put' && frame.event !== 'patch') continue;
        let body;
        try { body = JSON.parse(frame.data); } catch { continue; }
        const at = revisionOf(body?.data);
        if (at === null) { if (body?.data !== null) onWake(path); continue; }
        if (at <= seen) continue;
        const first = seen < 0;
        seen = at;
        if (!first) onWake(path);
      }
    } catch (e) {
      if (scope.signal.aborted) return;
      if (/auth_revoked|HTTP 401|HTTP 403/.test(String(e.message))) return; // the outer loop re-mints
      state.source = 'poll';
      state.degraded = `stream down (${e.message})`;
      log(`watch ${path}: ${state.degraded}`);
      try { await sleep(retry, scope.signal); } catch { return; }
      retry = Math.min(30_000, retry * 2);
    }
  }
}

/**
 * Phase 3 over the full emulator stack (docs/plan/agents.html §L): the loop
 * an orchestrator actually runs.
 *
 *   heartbeat 'working' → publish the plan as a task list → tick items off →
 *   ask a question the work depends on → a PERSON answers it in the app →
 *   the answer reaches the agent in its inbox feed, values and all →
 *   heartbeat 'done'.
 *
 * The in-process door tests (backend/test/platform/phase3-api.emu.test.ts)
 * pin the shapes; this one proves the pieces meet across real triggers — the
 * answer only reaches /v1/events because notify ran for real.
 */
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { SCOPE_PRESETS } from '@tm/shared';
import { call, eventually, http, newBoard, newPerson } from '../support/stack.js';

const bearer = (key: string) => ({
  authorization: `Bearer ${key}`,
  'content-type': 'application/json',
});

function client(key: string) {
  return {
    get: (p: string) => http(p, { headers: bearer(key) }),
    send: (method: string, p: string, body?: unknown) =>
      http(p, {
        method,
        headers: bearer(key),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}

/** A command a parallel step owns; its door is only exercised once it exists. */
const landed = (name: string): boolean =>
  existsSync(new URL(`../../../backend/src/commands/${name}.ts`, import.meta.url));

const FIELDS = [
  {
    id: 'db',
    label: 'Which database should the report use?',
    type: 'single',
    options: [
      { id: 'pg', label: 'Postgres' },
      { id: 'bq', label: 'BigQuery', description: 'costs per query' },
    ],
    required: true,
  },
  { id: 'why', label: 'Why?', type: 'text' },
];

test('§L: an agent beats, plans, asks — and a person answers', async () => {
  const ada = await newPerson('Ada');
  const eng = await newBoard(ada, { name: 'Phase 3 board' });
  const { agentId } = await call(ada, 'agentCreate', {
    name: 'Builder',
    description: 'Builds things',
    systemPrompt: '# You are Builder\n\nAsk before guessing.',
  });
  await call(ada, 'boardAgentSet', { boardId: eng.id, agentId, role: 'editor' });
  const { key } = await call(ada, 'apiKeyCreate', {
    name: 'orch-builder',
    boardId: eng.id,
    actsAs: { kind: 'agent', id: agentId },
    // The Worker preset is what §L4 says carries questions / tasklists / status.
    scopes: [...SCOPE_PRESETS.worker],
  });
  const { get, send } = client(key);

  const { ticketId, key: ticketKey } = await call(ada, 'ticketCreate', {
    boardId: eng.id,
    title: 'Add CSV export',
    assigneeUids: [agentId],
  });

  // ── heartbeat: 'I am on it' (§L3) ──
  if (landed('agentHeartbeat')) {
    const beat = await send('POST', '/v1/heartbeat', {
      ticket: ticketKey,
      state: 'working',
      message: 'Reading the code',
      progress: 0.1,
    });
    expect(beat.status, JSON.stringify(beat.body)).toBe(200);
    expect(beat.body).toMatchObject({
      agent: { id: agentId },
      ticket_key: ticketKey,
      state: 'working',
      health: 'working',
    });
    const live = await get(`/v1/agents/status?ticket=${ticketKey}`);
    expect(live.body.data.map((s: { agent: { id: string } }) => s.agent.id)).toContain(agentId);
  }

  // ── the plan as a checklist (§L2) ──
  const plan = await send('PUT', `/v1/tickets/${ticketKey}/tasklists/plan`, {
    title: 'Plan: add CSV export',
    items: [
      { id: 'read', title: 'Read the exporter' },
      { id: 'write', title: 'Write the CSV writer', status: 'doing' },
      { id: 'tests', title: 'Tests' },
    ],
  });
  expect(plan.status, JSON.stringify(plan.body)).toBe(200);
  expect(plan.body).toMatchObject({
    id: 'plan',
    owner: { id: agentId, kind: 'agent' },
    progress: { done: 0, total: 3 },
  });

  const ticked = await send('PATCH', `/v1/tickets/${ticketKey}/tasklists/plan/items/read`, {
    status: 'done',
  });
  expect(ticked.status, JSON.stringify(ticked.body)).toBe(200);
  expect(ticked.body.progress).toEqual({ done: 1, total: 3 });

  // ── the question the work depends on (§L1) ──
  const asked = await send('POST', `/v1/tickets/${ticketKey}/questions`, {
    title: 'Which database should the report use?',
    body_markdown: 'Both are wired up already.',
    fields: FIELDS,
    allow_comment: true,
    to: [ada.email],
    blocking: true,
  });
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  const q = asked.body as { id: string; message_id: string; status: string };
  expect(q.status).toBe('open');

  // Waiting for an answer is 'idle', not silence (§L3).
  if (landed('agentHeartbeat')) {
    const idle = await send('POST', '/v1/heartbeat', {
      ticket: ticketKey,
      state: 'idle',
      message: 'waiting for an answer',
    });
    expect(idle.body).toMatchObject({ state: 'idle', health: 'idle' });
  }

  // ── the PERSON answers, in the app ──
  await call(ada, 'questionAnswer', {
    boardId: eng.id,
    ticketId,
    messageId: q.message_id,
    values: { db: 'bq', why: 'the report scans everything' },
    comment: 'ping me if that is wrong',
  });

  const read = await get(`/v1/questions/${q.id}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(read.body).toMatchObject({
    status: 'answered',
    answer: { by: { id: ada.uid }, comment: 'ping me if that is wrong' },
  });
  expect(read.body.answer.values).toEqual({ db: 'bq', why: 'the report scans everything' });

  // ── and it reaches the agent's inbox with the values ──
  const event = await eventually('the question_answered event', async () => {
    const r = await get('/v1/events');
    return (
      r.body.data?.find(
        (e: { type: string; question?: { id: string } }) =>
          e.type === 'question_answered' && e.question?.id === q.id,
      ) ?? null
    );
  });
  expect(event.question.values).toEqual({ db: 'bq', why: 'the report scans everything' });
  expect(event.question.answered_by.id).toBe(ada.uid);

  // ── finish the plan and say so ──
  await send('PATCH', `/v1/tickets/${ticketKey}/tasklists/plan/items/write`, { status: 'done' });
  const finished = await send('PATCH', `/v1/tickets/${ticketKey}/tasklists/plan/items/tests`, {
    status: 'done',
  });
  expect(finished.body.progress).toEqual({ done: 3, total: 3 });

  if (landed('agentHeartbeat')) {
    const done = await send('POST', '/v1/heartbeat', {
      ticket: ticketKey,
      state: 'done',
      message: 'CSV export shipped',
    });
    expect(done.body).toMatchObject({ state: 'done', health: 'done' });
    expect(done.body.ended_at).toBeTruthy();
  }
});

test('§L4: the scopes gate every phase-3 route', async () => {
  const ada = await newPerson('Ada');
  const eng = await newBoard(ada, { name: 'Scopes board' });
  const { ticketId: _t, key: ticketKey } = await call(ada, 'ticketCreate', {
    boardId: eng.id,
    title: 'Locked down',
  });
  const { key } = await call(ada, 'apiKeyCreate', {
    name: 'read only',
    boardId: eng.id,
    actsAs: { kind: 'user' },
    scopes: [...SCOPE_PRESETS.readOnly],
  });
  const { send } = client(key);

  for (const [method, path, body] of [
    ['POST', `/v1/tickets/${ticketKey}/questions`, { title: 'Which db?', fields: FIELDS }],
    ['PUT', `/v1/tickets/${ticketKey}/tasklists/plan`, { title: 'Plan', items: [] }],
    ['PATCH', `/v1/tickets/${ticketKey}/tasklists/plan/items/a`, { status: 'done' }],
    ['DELETE', `/v1/tickets/${ticketKey}/tasklists/plan`, undefined],
    ['POST', '/v1/heartbeat', { state: 'working' }],
  ] as [string, string, unknown][]) {
    const r = await send(method, path, body);
    expect(r.status, `${method} ${path}`).toBe(403);
    expect(r.headers.get('content-type')).toContain('application/problem+json');
  }
});

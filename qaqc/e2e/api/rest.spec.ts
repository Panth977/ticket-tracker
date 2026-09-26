/**
 * Flows: "Scripting with the REST API" and the phase-2 orchestrator loop
 * (docs/plan/agents.html §E–§F) against the full emulator stack.
 *
 *   1. A PERSON's board token (apiKeyCreate v2: one board, acts as me) drives
 *      /v1 end to end; every change is the SAME command the app runs.
 *   2. An AGENT's token (agentCreate → boardAgentSet → apiKeyCreate actsAs
 *      agent) loads its system prompt from /v1/me, finds the ticket assigned
 *      to it, uploads a Markdown document, posts it, and reads its inbox.
 */
import { expect, test } from '@playwright/test';
import { SCOPE_PRESETS } from '@tm/shared';
import { call, eventually, http, newBoard, newPerson, read, stage } from '../support/stack.js';

const bearer = (key: string) => ({
  authorization: `Bearer ${key}`,
  'content-type': 'application/json',
});

function client(key: string) {
  return {
    get: (p: string) => http(p, { headers: bearer(key) }),
    send: (method: string, p: string, body: unknown, extra: Record<string, string> = {}) =>
      http(p, { method, headers: { ...bearer(key), ...extra }, body: JSON.stringify(body) }),
  };
}

test('REST with a personal board token: me, board, create, patch, move, message, search, scope narrowing', async () => {
  const ada = await newPerson('Ada');
  const eng = await newBoard(ada, { name: 'REST board' });
  const { key } = await call(ada, 'apiKeyCreate', {
    name: 'e2e script',
    boardId: eng.id,
    actsAs: { kind: 'user' },
    scopes: [...SCOPE_PRESETS.everything],
  });
  expect(key).toMatch(/^tm_live_/);
  const { get, send } = client(key);

  // no credential → 401 problem+json
  const anon = await http('/v1/me');
  expect(anon.status).toBe(401);

  const me = await get('/v1/me');
  expect(me.status).toBe(200);
  expect(me.body).toMatchObject({
    principal: { kind: 'user', id: ada.uid, email: ada.email },
    board: { key: eng.key },
    via: 'api',
  });

  const board = await get('/v1/board');
  expect(board.status).toBe(200);
  expect(board.body.key).toBe(eng.key);

  // create — by names, Markdown description, Idempotency-Key makes a retry one ticket
  const body = {
    title: 'Created over REST',
    description_md: 'From **a script**',
    stage: 'To do',
    priority: 'High',
    assignees: ['me'],
  };
  const created = await send('POST', '/v1/tickets', body, { 'Idempotency-Key': 'rest-e2e-1' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const t = created.body;
  expect(t).toMatchObject({
    key: `${eng.key}-1`,
    title: 'Created over REST',
    stage: { name: 'To do' },
    priority: { name: 'High' },
  });
  expect(t.assignees[0].email).toBe(ada.email);
  const again = await send('POST', '/v1/tickets', body, { 'Idempotency-Key': 'rest-e2e-1' });
  expect(again.body.id).toBe(t.id);

  // it is an ordinary ticket: the app's Firestore doc
  const doc = await read(`boards/${eng.id}/tickets/${t.id}`);
  expect(doc?.title).toBe('Created over REST');

  const fetched = await get(`/v1/tickets/${t.key}`);
  expect(fetched.body.description_md).toContain('**a script**');

  const patched = await send('PATCH', `/v1/tickets/${t.key}`, {
    title: 'Renamed over REST',
    due_at: '2030-01-02T00:00:00.000Z',
  });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  expect(patched.body.title).toBe('Renamed over REST');

  const moved = await send('POST', `/v1/tickets/${t.key}/move`, { stage: 'In progress' });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(moved.body.stage.id).toBe(stage(eng, 'In progress'));

  const posted = await send('POST', `/v1/tickets/${t.key}/messages`, {
    body_markdown: `Ping @${ada.email} — see #${t.key}`,
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(201);
  expect(posted.body).toMatchObject({ via: 'api', via_token: 'e2e script' });
  const messages = await get(`/v1/tickets/${t.key}/messages`);
  expect(JSON.stringify(messages.body.data)).toContain('Ping');

  const mine = await get(`/v1/tickets?assignee=me&stage=${encodeURIComponent('In progress')}`);
  expect(mine.body.data.map((x: { key: string }) => x.key)).toContain(t.key);

  const search = await get(`/v1/search?q=${encodeURIComponent('Renamed')}`);
  expect(search.status).toBe(200);

  // a narrower token: read-only cannot write (403)
  const { key: ro } = await call(ada, 'apiKeyCreate', {
    name: 'read only',
    boardId: eng.id,
    actsAs: { kind: 'user' },
    scopes: [...SCOPE_PRESETS.readOnly],
  });
  const denied = await client(ro).send('POST', '/v1/tickets', { title: 'nope' });
  expect(denied.status).toBe(403);
  expect(denied.headers.get('content-type')).toContain('application/problem+json');
});

test('REST with an agent token: system prompt, assigned work, a Markdown document, the inbox', async () => {
  const ada = await newPerson('Ada');
  const eng = await newBoard(ada, { name: 'Agent board' });
  const { agentId } = await call(ada, 'agentCreate', {
    name: 'Builder',
    description: 'Builds things',
    systemPrompt: '# You are Builder\n\nShip small, verified increments.',
  });
  await call(ada, 'boardAgentSet', { boardId: eng.id, agentId, role: 'editor' });
  const { key } = await call(ada, 'apiKeyCreate', {
    name: 'orch-builder',
    boardId: eng.id,
    actsAs: { kind: 'agent', id: agentId },
    scopes: [...SCOPE_PRESETS.worker],
  });
  const { get, send } = client(key);

  const me = await get('/v1/me');
  expect(me.status, JSON.stringify(me.body)).toBe(200);
  expect(me.body.principal).toMatchObject({
    kind: 'agent',
    id: agentId,
    name: 'Builder',
    system_prompt: expect.stringContaining('You are Builder'),
  });

  // Ada assigns the agent in the app; the agent finds it with assignee=me.
  const { key: ticketKey } = await call(ada, 'ticketCreate', {
    boardId: eng.id,
    title: 'Write the plan',
    assigneeUids: [agentId],
  });
  const mine = await get('/v1/tickets?assignee=me');
  expect(mine.body.data.map((x: { key: string }) => x.key)).toEqual([ticketKey]);

  const up = await send('POST', `/v1/tickets/${ticketKey}/files`, {
    name: 'plan.md',
    text: '# Plan\n\n1. Build it',
  });
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  expect(up.body).toMatchObject({ kind: 'markdown', uploaded_by: { id: agentId, kind: 'agent' } });

  const posted = await send('POST', `/v1/tickets/${ticketKey}/messages`, {
    body_markdown: 'The plan is attached.',
    attachments: [up.body.file_id],
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(201);
  expect(posted.body).toMatchObject({
    author: { id: agentId, kind: 'agent' },
    via_token: 'orch-builder',
  });

  const content = await get(`/v1/files/${up.body.file_id}?content=1`);
  expect(content.body.content).toBe('# Plan\n\n1. Build it');

  // The assignment reached the agent's inbox (notify trigger).
  const feed = await eventually('the assigned event', async () => {
    const r = await get('/v1/events');
    return r.body.data?.some(
      (e: { type: string; ticket_key: string }) =>
        e.type === 'assigned' && e.ticket_key === ticketKey,
    )
      ? r.body
      : null;
  });
  const ack = await send('POST', '/v1/events/ack', { upTo: feed.next_cursor });
  expect(ack.status).toBe(200);
  expect(ack.body.acked).toBeGreaterThanOrEqual(1);

  // A Worker token cannot create tickets.
  expect((await send('POST', '/v1/tickets', { title: 'nope' })).status).toBe(403);
});

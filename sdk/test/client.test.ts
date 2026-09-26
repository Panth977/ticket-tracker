/**
 * Every client method, against a mocked fetch: the right verb, the right
 * path, the right query and the right body — the places a typo costs a 400
 * in production and nothing here.
 */
import { describe, expect, it } from 'vitest';
import { createClient, toBase64 } from '../src/client.js';
import { normalizeBaseUrl } from '../src/http.js';
import { mockFetch, testClient } from './helpers.js';

describe('createClient', () => {
  it('needs a token', () => {
    // @ts-expect-error — the whole point is that this does not compile either
    expect(() => createClient({})).toThrow(/token/);
  });

  it('accepts an origin or a /v1 root', () => {
    expect(normalizeBaseUrl('https://tm.app')).toBe('https://tm.app/v1');
    expect(normalizeBaseUrl('https://tm.app/')).toBe('https://tm.app/v1');
    expect(normalizeBaseUrl('https://tm.app/v1')).toBe('https://tm.app/v1');
    expect(normalizeBaseUrl('https://tm.app/v1/')).toBe('https://tm.app/v1');
  });

  it('defaults to the hosted build', () => {
    const tm = createClient({ token: 't', fetch: (async () => new Response('{}')) as typeof fetch });
    expect(tm.baseUrl).toBe('https://taskmanager-example.web.app/v1');
  });

  it('sends the bearer token on every call', async () => {
    const f = mockFetch({ body: {} });
    await testClient(f).me();
    expect(f.last().headers.authorization).toBe('Bearer tm_live_test');
    expect(f.last().headers.accept).toBe('application/json');
  });

  it('adds a user-agent when asked', async () => {
    const f = mockFetch({ body: {} });
    await testClient(f, { userAgent: 'orch-eng/1.2' }).me();
    expect(f.last().headers['user-agent']).toBe('orch-eng/1.2');
  });
});

describe('identity and board', () => {
  it('me', async () => {
    const f = mockFetch({ body: { principal: { id: 'ag_x', kind: 'agent', name: 'Builder' }, scopes: ['tickets:read'] } });
    const me = await testClient(f).me();
    expect(f.last()).toMatchObject({ method: 'GET', path: '/me' });
    expect(me.principal.name).toBe('Builder');
  });

  it('board and boards', async () => {
    const f = mockFetch({ body: { id: 'b1', key: 'ENG' } });
    const tm = testClient(f);
    await tm.board();
    expect(f.last().path).toBe('/board');
    f.queue({ body: { data: [], next_cursor: null } });
    await tm.boards();
    expect(f.last().path).toBe('/boards');
  });

  it('search', async () => {
    const f = mockFetch({ body: { data: [] } });
    await testClient(f).search('csv export', { limit: 5 });
    expect(f.last()).toMatchObject({ method: 'GET', path: '/search', query: { q: 'csv export', limit: '5' } });
  });
});

describe('tickets', () => {
  it('list maps camelCase filters onto the query string', async () => {
    const f = mockFetch({ body: { data: [], next_cursor: null } });
    await testClient(f).tickets.list({ assignee: 'me', state: 'active', updatedSince: '2026-09-01T00:00:00Z', stage: 'QA', q: 'csv', limit: 10 });
    expect(f.last().query).toEqual({
      assignee: 'me',
      state: 'active',
      updated_since: '2026-09-01T00:00:00Z',
      stage: 'QA',
      q: 'csv',
      limit: '10',
    });
  });

  it('list leaves out what was not asked for', async () => {
    const f = mockFetch({ body: { data: [], next_cursor: null } });
    await testClient(f).tickets.list();
    expect(f.last().url).toBe('http://tm.test/v1/tickets');
  });

  it('iterate follows next_cursor and stops at the end', async () => {
    const f = mockFetch(
      { body: { data: [{ key: 'ENG-1' }, { key: 'ENG-2' }], next_cursor: 'c1' } },
      { body: { data: [{ key: 'ENG-3' }], next_cursor: null } },
    );
    const keys: string[] = [];
    for await (const t of testClient(f).tickets.iterate({ assignee: 'me' })) keys.push(t.key);
    expect(keys).toEqual(['ENG-1', 'ENG-2', 'ENG-3']);
    expect(f.calls[1]!.query.cursor).toBe('c1');
  });

  it('get asks for messages only when told to', async () => {
    const f = mockFetch({ body: {} });
    const tm = testClient(f);
    await tm.tickets.get('ENG-42');
    expect(f.last()).toMatchObject({ method: 'GET', path: '/tickets/ENG-42', query: {} });
    f.queue({ body: {} });
    await tm.tickets.get('ENG-42', { messages: 20 });
    expect(f.last().query).toEqual({ messages: '20' });
  });

  it('create turns camelCase into the REST body', async () => {
    const f = mockFetch({ status: 201, body: { key: 'ENG-9' } });
    await testClient(f).tickets.create({
      title: 'Add CSV export',
      description: '# Why\nBecause.',
      assignees: ['me'],
      dueAt: '2026-10-01T00:00:00Z',
      priority: 'High',
      tags: ['api'],
      fields: { Team: 'Platform' },
    });
    expect(f.last()).toMatchObject({ method: 'POST', path: '/tickets' });
    expect(f.last().body).toEqual({
      title: 'Add CSV export',
      description_md: '# Why\nBecause.',
      assignees: ['me'],
      due_at: '2026-10-01T00:00:00Z',
      priority: 'High',
      tags: ['api'],
      fields: { Team: 'Platform' },
    });
  });

  it('update sends only what was set — and keeps explicit nulls', async () => {
    const f = mockFetch({ body: {} });
    await testClient(f).tickets.update('ENG-42', { dueAt: null, title: 'New' });
    expect(f.last()).toMatchObject({ method: 'PATCH', path: '/tickets/ENG-42' });
    expect(f.last().body).toEqual({ title: 'New', due_at: null });
  });

  it('move, state and assign', async () => {
    const f = mockFetch({ body: {} });
    const tm = testClient(f);
    await tm.tickets.move('ENG-42', 'QA');
    expect(f.last()).toMatchObject({ method: 'POST', path: '/tickets/ENG-42/move', body: { stage: 'QA' } });
    f.queue({ body: {} });
    await tm.tickets.state('ENG-42', 'archived');
    // No `reason`: the state is archive/restore only, and the API body is strict.
    expect(f.last()).toMatchObject({ path: '/tickets/ENG-42/state', body: { state: 'archived' } });
    f.queue({ body: {} });
    await tm.tickets.assign('ENG-42', { add: ['ag_1'], remove: ['u2'] });
    expect(f.last()).toMatchObject({ path: '/tickets/ENG-42/assignees', body: { add: ['ag_1'], remove: ['u2'] } });
  });

  it('escapes a key in the path', async () => {
    const f = mockFetch({ body: {} });
    await testClient(f).tickets.get('ENG 42/../secret');
    expect(f.last().url).toBe('http://tm.test/v1/tickets/ENG%2042%2F..%2Fsecret');
  });
});

describe('messages', () => {
  it('list', async () => {
    const f = mockFetch({ body: { data: [], next_cursor: null } });
    await testClient(f).messages.list('ENG-42', { cursor: 'c', limit: 10, order: 'desc' });
    expect(f.last()).toMatchObject({ method: 'GET', path: '/tickets/ENG-42/messages', query: { cursor: 'c', limit: '10', order: 'desc' } });
  });

  it('post', async () => {
    const f = mockFetch({ status: 201, body: { id: 'm1' } });
    await testClient(f).messages.post('ENG-42', { markdown: 'Done.', attachments: ['f1'], replyTo: 'm0' });
    expect(f.last()).toMatchObject({
      method: 'POST',
      path: '/tickets/ENG-42/messages',
      body: { body_markdown: 'Done.', attachments: ['f1'], reply_to: 'm0' },
    });
  });

  it('post allows a files-only message', async () => {
    const f = mockFetch({ status: 201, body: {} });
    await testClient(f).messages.post('ENG-42', { attachments: ['f1'] });
    expect(f.last().body).toEqual({ body_markdown: '', attachments: ['f1'] });
  });

  it('post carries the turn receipt as snake_case, with absent optionals as null (§Y1)', async () => {
    const f = mockFetch({ status: 201, body: { id: 'm1', run: { n: 3 } } });
    await testClient(f).messages.post('ENG-42', {
      markdown: 'Turn 3 · review · $1.24 · 12 min',
      run: { n: 3, outcome: 'review', costUsd: 1.24, sessionUsd: 21.1, durationMs: 743000, apiTurns: 46, model: 'claude-fable-5-1', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
    });
    expect(f.last().body).toEqual({
      body_markdown: 'Turn 3 · review · $1.24 · 12 min',
      run: { n: 3, outcome: 'review', cost_usd: 1.24, session_usd: 21.1, duration_ms: 743000, api_turns: 46, model: 'claude-fable-5-1', usage: { input: 1, output: 2, cache_read: 3, cache_write: 4 } },
    });
    f.queue({ status: 201, body: {} });
    await testClient(f).messages.post('ENG-42', { markdown: 'Turn 1', run: { n: 1, outcome: 'failed', costUsd: 0.5, durationMs: 1000 } });
    expect(f.last().body).toEqual({
      body_markdown: 'Turn 1',
      run: { n: 1, outcome: 'failed', cost_usd: 0.5, session_usd: null, duration_ms: 1000, api_turns: null, model: null, usage: null },
    });
  });
});

describe('account-token routes (§Z2) and the live credential (§W)', () => {
  it('agents.create', async () => {
    const f = mockFetch({ status: 201, body: { id: 'ag_1', kind: 'agent' } });
    const a = await testClient(f).agents.create({ name: 'Builder', description: 'Builds', systemPrompt: '# You build' });
    expect(a.id).toBe('ag_1');
    expect(f.last()).toMatchObject({ method: 'POST', path: '/agents', body: { name: 'Builder', description: 'Builds', system_prompt: '# You build' } });
    expect(f.last().body).not.toHaveProperty('avatar');
  });

  it('boards.create and boards.setAgent', async () => {
    const f = mockFetch({ status: 201, body: { id: 'b1', key: 'OCZ' } });
    const tm = testClient(f);
    await tm.boards.create({ name: 'Octupuz', key: 'OCZ', template: 'kanban' });
    expect(f.last()).toMatchObject({ method: 'POST', path: '/boards', body: { name: 'Octupuz', key: 'OCZ', template: 'kanban' } });
    f.queue({ body: { ok: true } });
    await tm.boards.setAgent('OCZ', { agent: 'ag_1', role: 'editor' });
    expect(f.last()).toMatchObject({ method: 'POST', path: '/boards/OCZ/agents', body: { agent: 'ag_1', role: 'editor' } });
    expect(f.last().body).not.toHaveProperty('stage_grant');
    f.queue({ body: { ok: true } });
    await tm.boards.setAgent('OCZ', { agent: 'ag_1', role: 'commenter', stageGrant: { stages: ['s1'], assignedOnly: true } });
    expect(f.last().body).toEqual({ agent: 'ag_1', role: 'commenter', stage_grant: { stages: ['s1'], assigned_only: true } });
    f.queue({ body: { ok: true } });
    await tm.boards.setAgent('OCZ', { agent: 'ag_1', role: null, stageGrant: null });
    expect(f.last().body).toEqual({ agent: 'ag_1', role: null, stage_grant: null });
    // The callable form and .list() are unchanged.
    f.queue({ body: { data: [], next_cursor: null } });
    await tm.boards();
    expect(f.last()).toMatchObject({ method: 'GET', path: '/boards' });
  });

  it('live', async () => {
    const f = mockFetch({ body: { database_url: 'https://x.firebasedatabase.app', auth: 'idtok', expires_in: 3600, paths: ['rev/b1'] } });
    const cred = await testClient(f).live();
    expect(f.last()).toMatchObject({ method: 'GET', path: '/live' });
    expect(cred.paths).toEqual(['rev/b1']);
  });
});

describe('files', () => {
  it('upload text', async () => {
    const f = mockFetch({ status: 201, body: { id: 'f1', file_id: 'f1' } });
    const file = await testClient(f).files.upload('ENG-42', { name: 'report.html', text: '<h1>ok</h1>' });
    expect(f.last()).toMatchObject({ method: 'POST', path: '/tickets/ENG-42/files', body: { name: 'report.html', text: '<h1>ok</h1>' } });
    expect(file.file_id).toBe('f1');
  });

  it('upload bytes as base64', async () => {
    const f = mockFetch({ status: 201, body: {} });
    await testClient(f).files.upload('ENG-42', { name: 'x.bin', bytes: new Uint8Array([1, 2, 3, 4, 5]) });
    expect((f.last().body as { content_base64: string }).content_base64).toBe(Buffer.from([1, 2, 3, 4, 5]).toString('base64'));
  });

  it('upload refuses two contents at once', async () => {
    const f = mockFetch({ body: {} });
    expect(() => testClient(f).files.upload('ENG-42', { name: 'x', text: 'a', base64: 'b' })).toThrow(/exactly one/);
  });

  it('get and read', async () => {
    const f = mockFetch({ body: { id: 'f1', content: '# Plan', textual: true } });
    const tm = testClient(f);
    await tm.files.get('f1');
    expect(f.last()).toMatchObject({ method: 'GET', path: '/files/f1', query: {} });
    f.queue({ body: { id: 'f1', content: '# Plan' } });
    expect(await tm.files.read('f1')).toBe('# Plan');
    expect(f.last().query).toEqual({ content: '1' });
  });

  it('list', async () => {
    const f = mockFetch({ body: { data: [] } });
    await testClient(f).files.list('ENG-42');
    expect(f.last().path).toBe('/tickets/ENG-42/files');
  });
});

describe('questions', () => {
  it('ask sends the form and expands string options', async () => {
    const f = mockFetch({ status: 201, body: { id: 'q1', status: 'open' } });
    const q = await testClient(f).questions.ask('ENG-42', {
      title: 'Which database?',
      blocking: true,
      fields: [{ id: 'db', label: 'Database', type: 'single', options: ['Postgres', 'SQLite'], required: true }],
    });
    expect(q.id).toBe('q1');
    expect(f.last()).toMatchObject({ method: 'POST', path: '/tickets/ENG-42/questions' });
    expect(f.last().body).toEqual({
      title: 'Which database?',
      blocking: true,
      fields: [
        {
          id: 'db',
          label: 'Database',
          type: 'single',
          options: [
            { id: 'Postgres', label: 'Postgres' },
            { id: 'SQLite', label: 'SQLite' },
          ],
          required: true,
        },
      ],
    });
  });

  it('waitForAnswer polls until somebody submits, and types the values', async () => {
    const f = mockFetch(
      { status: 201, body: { id: 'q1', status: 'open', answer: null } },
      { body: { id: 'q1', status: 'open', answer: null } },
      { body: { id: 'q1', status: 'answered', answer: { values: { db: 'Postgres' }, comment: null, by: { id: 'u1', kind: 'user', name: 'P' }, at: 'now' } } },
    );
    const answer = await testClient(f)
      .questions.ask('ENG-42', {
        title: 'Which database?',
        fields: [{ id: 'db', label: 'Database', type: 'single', options: ['Postgres', 'SQLite'] }],
      })
      .waitForAnswer({ pollMs: 1 });
    // `db` is known to be a string because the field said `single`.
    const chosen: string = answer.values.db;
    expect(chosen).toBe('Postgres');
    expect(answer.question.status).toBe('answered');
    expect(f.calls.filter((c) => c.path === '/questions/q1')).toHaveLength(2);
  });

  it('waitForAnswer gives up when the question is cancelled', async () => {
    const f = mockFetch({ status: 201, body: { id: 'q1', status: 'open' } }, { body: { id: 'q1', status: 'cancelled' } });
    await expect(
      testClient(f)
        .questions.ask('ENG-42', { title: 'x', fields: [{ id: 'a', label: 'A', type: 'text' }] })
        .waitForAnswer({ pollMs: 1 }),
    ).rejects.toMatchObject({ code: 'gone' });
  });

  it('waitForAnswer times out', async () => {
    let now = 0;
    const f = mockFetch({ status: 201, body: { id: 'q1', status: 'open' } }, { body: { id: 'q1', status: 'open' } });
    const tm = testClient(f, { now: () => (now += 10_000) });
    await expect(
      tm.questions.ask('ENG-42', { title: 'x', fields: [{ id: 'a', label: 'A', type: 'text' }] }).waitForAnswer({ timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('get and cancel', async () => {
    const f = mockFetch({ body: { id: 'q1' } });
    const tm = testClient(f);
    await tm.questions.get('q1');
    expect(f.last()).toMatchObject({ method: 'GET', path: '/questions/q1' });
    f.queue({ body: { id: 'q1', status: 'cancelled' } });
    await tm.questions.cancel('q1');
    expect(f.last()).toMatchObject({ method: 'POST', path: '/questions/q1/cancel' });
  });
});

describe('task lists', () => {
  it('set turns plain strings into items and names the list itself', async () => {
    const f = mockFetch({ body: { id: 'l1' } });
    await testClient(f).tasklists.set('ENG-42', { title: 'Plan', items: ['Read the spec', 'Write it', { title: 'Test it', status: 'doing' }] });
    expect(f.last().method).toBe('PUT');
    expect(f.last().path).toMatch(/^\/tickets\/ENG-42\/tasklists\/.+/);
    expect(f.last().body).toEqual({
      title: 'Plan',
      items: [{ title: 'Read the spec' }, { title: 'Write it' }, { title: 'Test it', status: 'doing' }],
    });
  });

  it('set reuses a listId when given one', async () => {
    const f = mockFetch({ body: {} });
    await testClient(f).tasklists.set('ENG-42', { title: 'Plan', items: [], listId: 'l1', closed: true });
    expect(f.last().path).toBe('/tickets/ENG-42/tasklists/l1');
    expect(f.last().body).toMatchObject({ closed: true });
  });

  it('item and delete', async () => {
    const f = mockFetch({ body: {} });
    const tm = testClient(f);
    await tm.tasklists.item('ENG-42', 'l1', 'i2', { status: 'done', note: null });
    expect(f.last()).toMatchObject({ method: 'PATCH', path: '/tickets/ENG-42/tasklists/l1/items/i2', body: { status: 'done', note: null } });
    f.queue({ body: { deleted: true } });
    await tm.tasklists.delete('ENG-42', 'l1');
    expect(f.last()).toMatchObject({ method: 'DELETE', path: '/tickets/ENG-42/tasklists/l1' });
  });
});

describe('heartbeat', () => {
  it('send', async () => {
    const f = mockFetch({ body: {} });
    await testClient(f).heartbeat.send('working', { ticket: 'ENG-42', message: 'Running tests', progress: 0.5 });
    expect(f.last()).toMatchObject({
      method: 'POST',
      path: '/heartbeat',
      body: { state: 'working', ticket: 'ENG-42', message: 'Running tests', progress: 0.5 },
    });
  });

  it('start beats at once, update changes what it says, done stops it', async () => {
    const f = mockFetch({ body: {} });
    const beat = testClient(f).heartbeat.start({ ticket: 'ENG-42', message: 'Running tests', everyMs: 50_000 });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.calls[0]).toMatchObject({ path: '/heartbeat', body: { state: 'working', message: 'Running tests' } });

    await beat.update({ message: 'Writing the report', progress: 0.8 });
    expect(f.last().body).toMatchObject({ state: 'working', message: 'Writing the report', progress: 0.8 });

    expect(beat.running).toBe(true);
    await beat.done();
    expect(f.last().body).toMatchObject({ state: 'done', message: 'Writing the report' });
    expect(beat.running).toBe(false);
  });

  it('error carries the message and stops the timer', async () => {
    const f = mockFetch({ body: {} });
    const beat = testClient(f).heartbeat.start({ ticket: 'ENG-42', everyMs: 50_000 });
    await beat.error('tests failed');
    expect(f.last().body).toMatchObject({ state: 'error', message: 'tests failed' });
    expect(beat.running).toBe(false);
  });

  it('a failed beat is reported, not thrown', async () => {
    const f = mockFetch({ status: 503, body: {} });
    const seen: unknown[] = [];
    const beat = testClient(f).heartbeat.start({ everyMs: 50_000, onError: (e) => seen.push(e) });
    await new Promise((r) => setTimeout(r, 5));
    beat.stop();
    expect(seen).toHaveLength(1);
  });
});

describe('events', () => {
  it('list and ack', async () => {
    const f = mockFetch({ body: { data: [], next_cursor: null, has_more: false } });
    const tm = testClient(f);
    await tm.events.list({ cursor: 'ev1', limit: 20, unacked: true });
    expect(f.last()).toMatchObject({ method: 'GET', path: '/events', query: { cursor: 'ev1', limit: '20', unacked: '1' } });
    f.queue({ body: { acked: 2 } });
    await tm.events.ack(['ev1', 'ev2']);
    expect(f.last()).toMatchObject({ method: 'POST', path: '/events/ack', body: { ids: ['ev1', 'ev2'] } });
    f.queue({ body: { acked: 5 } });
    await tm.events.ack({ upTo: 'ev9' });
    expect(f.last().body).toEqual({ upTo: 'ev9' });
  });
});

describe('the escape hatch', () => {
  it('request() reaches any route', async () => {
    const f = mockFetch({ body: { ok: true } });
    const out = await testClient(f).request<{ ok: boolean }>('GET', '/agents/status', { query: { ticket: 'ENG-1' } });
    expect(out.ok).toBe(true);
    expect(f.last()).toMatchObject({ method: 'GET', path: '/agents/status', query: { ticket: 'ENG-1' } });
  });

  it('agents.status and webhooks', async () => {
    const f = mockFetch({ body: { data: [] } });
    const tm = testClient(f);
    await tm.agents.status({ ticket: 'ENG-1' });
    expect(f.last().path).toBe('/agents/status');
    f.queue({ body: { data: [], next_cursor: null } });
    await tm.webhooks.list();
    expect(f.last().path).toBe('/webhooks');
  });
});

describe('toBase64', () => {
  it('matches Buffer for every padding length', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 17, 255]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) % 256);
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});

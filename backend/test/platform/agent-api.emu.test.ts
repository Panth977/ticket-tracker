/**
 * Phase 2 (docs/plan/agents.html §E–§G): board tokens that ACT AS AN AGENT,
 * driving REST /v1 and MCP. The orchestrator loop end to end:
 *
 *   owner makes a token for their agent on a board → the token reads the
 *   agent's profile (system prompt), its assigned tickets, uploads Markdown
 *   and HTML documents, posts them in the thread, reads and acks its inbox.
 *
 * Agents and their board membership are seeded as documents (the same ones
 * agentCreate / boardAgentSet write) — this file is about the doors.
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { paths, SCOPE_PRESETS, type ApiKey, type Message, type TicketFile } from '@tm/shared';
import { createApp } from '../../src/http/app.js';
import { db } from '../../src/runtime/firebase.js';
import { request, setupEmulators } from '../harness/index.js';
import { memoryFiles, people, seedBoard, STAGES } from '../tickets/helpers.js';
import { fileOf, msgsOf } from '../tickets/store.js';
import { setPorts } from '../harness/index.js';
import {
  agentKeyFor,
  apiKeyFor,
  putAgentOnBoard,
  removeAgentFromBoard,
  rest,
  seedAgent,
  seedAgentEvent,
} from './helpers.js';

setupEmulators();

/** Parallel steps may not have landed messagePost { fileIds } yet (p2-agents-backend t3). */
const messagePostTakesFileIds = readFileSync(
  new URL('../../src/commands/messagePost.ts', import.meta.url),
  'utf8',
).includes('fileIds');

/** In-memory Storage that really keeps bytes (the upload → read round trip). */
function bytesFiles() {
  const base = memoryFiles();
  const blobs = new Map<string, Uint8Array>();
  const files = {
    ...base,
    async write(p: string, data: Uint8Array, contentType: string) {
      blobs.set(p, data);
      await base.write(p, data, contentType);
    },
    async read(p: string) {
      const b = blobs.get(p);
      if (!b) throw new Error(`no ${p}`);
      return b;
    },
  };
  setPorts({ files });
  return { files, blobs };
}

async function agentBoard(role: 'editor' | 'commenter' | 'viewer' = 'editor') {
  const { owner, priya } = await people('owner', 'priya');
  const b = await seedBoard({ admin: owner, editors: [priya] });
  const { id: agentId, agent } = await seedAgent(owner, { name: 'Builder', boardId: b.id, role });
  return { owner, priya, b, agentId, agent };
}

describe('apiKeyCreate v2: acting as an agent', () => {
  it('only your own agent, not archived, already on that board; stored with actsAs', async () => {
    const { owner, priya, b, agentId } = await agentBoard();
    const { key, keyId } = await agentKeyFor(owner, agentId, [...SCOPE_PRESETS.worker], b.id);
    const row = (await db().doc(paths.apiKey(owner.uid, keyId)).get()).data() as ApiKey;
    expect(row).toMatchObject({
      boardId: b.id,
      actsAs: { kind: 'agent', id: agentId },
      name: 'orch-builder',
    });
    expect(key).toMatch(/^tm_live_/);

    // Someone else's agent looks like no agent at all.
    await expect(agentKeyFor(priya, agentId, ['board:read'], b.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    // Not on this board yet.
    const other = await seedBoard({ admin: owner });
    await expect(agentKeyFor(owner, agentId, ['board:read'], other.id)).rejects.toMatchObject({
      code: 'invalid',
    });
    // Agents never carry admin scopes (schema).
    await expect(
      agentKeyFor(owner, agentId, ['board:read', 'webhooks:manage'], b.id),
    ).rejects.toMatchObject({ code: 'invalid' });
    // Archived agents get no new tokens.
    await db().doc(paths.agent(agentId)).update({ archivedAt: Date.now() });
    await expect(agentKeyFor(owner, agentId, ['board:read'], b.id)).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('the token stops working when the agent leaves the board or is archived', async () => {
    const { owner, b, agentId } = await agentBoard();
    const { key } = await agentKeyFor(owner, agentId, ['board:read'], b.id);
    expect((await rest(key, 'GET', '/v1/me')).status).toBe(200);
    await removeAgentFromBoard(agentId, b.id);
    expect((await rest(key, 'GET', '/v1/me')).status).toBe(401);
    await putAgentOnBoard(owner, agentId, 'Builder', b.id, 'editor');
    expect((await rest(key, 'GET', '/v1/me')).status).toBe(200);
    await db().doc(paths.agent(agentId)).update({ archivedAt: Date.now() });
    const r = await rest(key, 'GET', '/v1/me');
    expect(r.status).toBe(401);
    expect((r.body as { detail: string }).detail).toMatch(/archived/);
  });
});

describe('REST /v1 with an agent token', () => {
  it('me (system prompt), board with agents, my tickets, changes authored by the agent', async () => {
    const { owner, priya, b, agentId, agent } = await agentBoard();
    const { key } = await agentKeyFor(owner, agentId, [...SCOPE_PRESETS.everything], b.id);

    const me = await rest(key, 'GET', '/v1/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      principal: {
        kind: 'agent',
        id: agentId,
        name: 'Builder',
        email: null,
        system_prompt: agent.systemPrompt,
        description: 'Builds things',
      },
      owner: { id: owner.uid, email: owner.email },
      board: { id: b.id, key: b.key },
      role: 'editor',
      via: 'api',
      token: { name: 'orch-builder' },
    });

    const board = (await rest(key, 'GET', '/v1/board')).body as {
      members: { id: string; kind: string; name: string; email: string }[];
    };
    expect(board.members.find((m) => m.id === agentId)).toMatchObject({
      kind: 'agent',
      name: 'Builder',
      email: '',
    });

    // A person assigns the agent BY NAME; the agent finds it with assignee=me.
    const { key: ownerKey } = await apiKeyFor(owner, [...SCOPE_PRESETS.everything], b.id);
    const t = (
      await rest(ownerKey, 'POST', '/v1/tickets', {
        title: 'Write the plan',
        assignees: ['builder'],
      })
    ).body as {
      key: string;
      assignees: { id: string; kind: string }[];
    };
    expect(t.assignees).toEqual([expect.objectContaining({ id: agentId, kind: 'agent' })]);
    await rest(ownerKey, 'POST', '/v1/tickets', {
      title: 'Someone else',
      assignees: [priya.email],
    });
    const mine = (await rest(key, 'GET', '/v1/tickets?assignee=me')).body as {
      data: { key: string }[];
    };
    expect(mine.data.map((x) => x.key)).toEqual([t.key]);

    // Its changes are its own.
    const moved = await rest(key, 'POST', `/v1/tickets/${t.key}/move`, { stage: 'Doing' });
    expect((moved.body as { stage: { id: string } }).stage.id).toBe(STAGES.doing);
    const posted = await rest(key, 'POST', `/v1/tickets/${t.key}/messages`, {
      body_markdown: `Plan coming, @${priya.email}`,
    });
    expect(posted.status).toBe(201);
    // 'Builder (agent) via token orch-builder'
    expect(posted.body).toMatchObject({
      author: { id: agentId, kind: 'agent', name: 'Builder' },
      via: 'api',
      via_token: 'orch-builder',
    });
    const ticketId = (await db().doc(paths.key(t.key)).get()).get('ticketId') as string;
    const stored = (await msgsOf(b.id, ticketId)).find((m) => m.authorUid === agentId) as Message;
    expect(stored.via).toBe('api');
    expect(stored.markdown).toBe(`Plan coming, @${priya.email}`);
  });

  it('granular scopes: a Worker token cannot assign; a commenter agent cannot move outside its grant', async () => {
    const { owner, b, agentId } = await agentBoard();
    const { key } = await agentKeyFor(owner, agentId, [...SCOPE_PRESETS.worker], b.id);
    const { key: ownerKey } = await apiKeyFor(owner, [...SCOPE_PRESETS.everything], b.id);
    const t = (await rest(ownerKey, 'POST', '/v1/tickets', { title: 'x' })).body as { key: string };

    expect((await rest(key, 'POST', '/v1/tickets', { title: 'nope' })).status).toBe(403);
    expect((await rest(key, 'PATCH', `/v1/tickets/${t.key}`, { assignees: ['me'] })).status).toBe(
      403,
    );
    expect(
      (await rest(key, 'POST', `/v1/tickets/${t.key}/assignees`, { add: ['me'] })).status,
    ).toBe(403);
    expect(
      (await rest(key, 'POST', `/v1/tickets/${t.key}/state`, { state: 'archived' })).status,
    ).toBe(403);
    expect((await rest(key, 'PATCH', `/v1/tickets/${t.key}`, { title: 'Renamed' })).status).toBe(
      200,
    );

    // Commenter agent: move only between granted stages, whatever the token says.
    const { id: c } = await seedAgent(owner, {
      name: 'Reviewer',
      boardId: b.id,
      role: 'commenter',
      grant: { stages: [STAGES.todo, STAGES.doing] },
    });
    const { key: ck } = await agentKeyFor(
      owner,
      c,
      [...SCOPE_PRESETS.everything],
      b.id,
      'orch-reviewer',
    );
    expect((await rest(ck, 'POST', `/v1/tickets/${t.key}/move`, { stage: 'Review' })).status).toBe(
      403,
    );
    expect((await rest(ck, 'POST', `/v1/tickets/${t.key}/move`, { stage: 'Doing' })).status).toBe(
      200,
    );
    expect((await rest(ck, 'PATCH', `/v1/tickets/${t.key}`, { title: 'no' })).status).toBe(403);
  });

  it('files: JSON text (.md), multipart (.html), base64; get with a signed URL and ?content=1', async () => {
    bytesFiles();
    const { owner, b, agentId } = await agentBoard();
    const { key } = await agentKeyFor(owner, agentId, [...SCOPE_PRESETS.worker], b.id);
    const { key: ownerKey } = await apiKeyFor(owner, [...SCOPE_PRESETS.everything], b.id);
    const t = (await rest(ownerKey, 'POST', '/v1/tickets', { title: 'Docs' })).body as {
      key: string;
      id: string;
    };

    const md = await rest(key, 'POST', `/v1/tickets/${t.key}/files`, {
      name: 'plan.md',
      text: '# Plan\n\n- [ ] one',
    });
    expect(md.status).toBe(201);
    const mdFile = md.body as {
      file_id: string;
      kind: string;
      mime: string;
      url: string;
      source: string;
      uploaded_by: { id: string; kind: string };
    };
    expect(mdFile).toMatchObject({
      kind: 'markdown',
      mime: 'text/markdown',
      source: 'upload',
      uploaded_by: { id: agentId, kind: 'agent' },
    });
    expect(mdFile.url).toBeTruthy();

    const form = new FormData();
    form.append(
      'file',
      new Blob(['<!doctype html><h1>Report</h1>'], { type: 'text/html' }),
      'report.html',
    );
    const html = await request(`/v1/tickets/${t.key}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    expect(html.status).toBe(201);
    expect(html.body).toMatchObject({ kind: 'html', name: 'report.html', textual: true });

    const png = await rest(key, 'POST', `/v1/tickets/${t.key}/files`, {
      name: 'shot.png',
      content_base64: Buffer.from([137, 80, 78, 71]).toString('base64'),
    });
    expect(png.body).toMatchObject({ kind: 'image', size: 4, textual: false });

    const got = await rest(key, 'GET', `/v1/files/${mdFile.file_id}?content=1`);
    expect(got.body).toMatchObject({
      content: '# Plan\n\n- [ ] one',
      ticket_key: t.key,
      url_expires_at: expect.any(String),
    });
    const binary = await rest(
      key,
      'GET',
      `/v1/files/${(png.body as { file_id: string }).file_id}?content=1`,
    );
    expect(binary.status).toBe(422);
    expect(
      (await rest(key, 'GET', `/v1/files/${(png.body as { file_id: string }).file_id}`)).status,
    ).toBe(200);

    const list = (await rest(key, 'GET', `/v1/tickets/${t.key}/files`)).body as {
      data: { name: string }[];
    };
    expect(list.data.map((f) => f.name).sort()).toEqual(['plan.md', 'report.html', 'shot.png']);
    const row = (await fileOf(b.id, t.id, mdFile.file_id)) as TicketFile;
    expect(row).toMatchObject({ source: 'upload', messageId: null, uploadedBy: agentId });

    // Idempotent: the same key is the same file.
    const r1 = await rest(
      key,
      'POST',
      `/v1/tickets/${t.key}/files`,
      { name: 'a.txt', text: 'x' },
      { 'Idempotency-Key': 'up-1' },
    );
    const r2 = await rest(
      key,
      'POST',
      `/v1/tickets/${t.key}/files`,
      { name: 'a.txt', text: 'x' },
      { 'Idempotency-Key': 'up-1' },
    );
    expect((r1.body as { file_id: string }).file_id).toBe((r2.body as { file_id: string }).file_id);

    // Without files:write: refused; files of another board: not found.
    const { key: ro } = await agentKeyFor(owner, agentId, [...SCOPE_PRESETS.readOnly], b.id, 'ro');
    expect(
      (await rest(ro, 'POST', `/v1/tickets/${t.key}/files`, { name: 'x.md', text: 'x' })).status,
    ).toBe(403);
    const other = await seedBoard({ admin: owner });
    const { key: otherKey } = await apiKeyFor(owner, ['files:read'], other.id);
    expect((await rest(otherKey, 'GET', `/v1/files/${mdFile.file_id}`)).status).toBe(404);

    if (messagePostTakesFileIds) {
      const m = await rest(key, 'POST', `/v1/tickets/${t.key}/messages`, {
        body_markdown: '',
        attachments: [mdFile.file_id],
      });
      expect(m.status).toBe(201);
      expect((m.body as { attachments: { id: string; kind: string }[] }).attachments).toEqual([
        expect.objectContaining({ id: mdFile.file_id, kind: 'markdown' }),
      ]);
    }
  });

  it('events: cursor feed, SSE stream, ack — only this board, oldest first', async () => {
    const { owner, b, agentId } = await agentBoard();
    const { key } = await agentKeyFor(owner, agentId, ['events:read'], b.id);
    const other = await seedBoard({ admin: owner });
    const t0 = Date.now() - 10_000;
    const e1 = await seedAgentEvent(
      agentId,
      { boardId: b.id, ticketId: 't1', ticketKey: `${b.key}-1`, actor: owner.uid },
      t0,
    );
    const e2 = await seedAgentEvent(
      agentId,
      {
        boardId: b.id,
        ticketId: 't1',
        ticketKey: `${b.key}-1`,
        type: 'mentioned',
        messageId: 'm1',
      },
      t0 + 1,
    );
    await seedAgentEvent(
      agentId,
      { boardId: other.id, ticketId: 't9', ticketKey: `${other.key}-1` },
      t0 + 2,
    );

    const feed = await rest(key, 'GET', '/v1/events?limit=1');
    expect(feed.body).toMatchObject({
      data: [
        { id: e1, type: 'assigned', board: { key: b.key }, actor: { id: owner.uid, kind: 'user' } },
      ],
      next_cursor: e1,
      has_more: true,
    });
    const next = (await rest(key, 'GET', `/v1/events?cursor=${e1}`)).body as {
      data: { id: string; message_id: string }[];
      next_cursor: string;
      has_more: boolean;
    };
    expect(next.data.map((e) => e.id)).toEqual([e2]);
    expect(next.data[0]!.message_id).toBe('m1');
    expect(next.has_more).toBe(false);
    const idle = (await rest(key, 'GET', `/v1/events?cursor=${e2}`)).body as {
      data: unknown[];
      next_cursor: string;
    };
    expect(idle).toMatchObject({ data: [], next_cursor: e2 });

    // SSE: the stream replays from the cursor.
    const app = await createApp();
    const res = await app.request(`/v1/events/stream?cursor=${e1}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes(`id: ${e2}`)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(text).toContain('event: ping');
    expect(text).toContain(`event: event\ndata: `);
    expect(text).toContain(`id: ${e2}`);

    const ack = await rest(key, 'POST', '/v1/events/ack', { upTo: e1 });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ acked: 1 });
    const unacked = (await rest(key, 'GET', '/v1/events?unacked=1')).body as {
      data: { id: string }[];
    };
    expect(unacked.data.map((e) => e.id)).toEqual([e2]);
    expect((await rest(key, 'POST', '/v1/events/ack', { ids: [e2] })).body).toMatchObject({
      acked: 1,
    });
  });

  it("a person's token reads their own inbox as events", async () => {
    const { owner, b } = await agentBoard();
    const { key } = await apiKeyFor(owner, ['events:read'], b.id);
    await db()
      .collection(paths.inbox(owner.uid))
      .doc('n1')
      .set({
        event: 'assigned',
        boardId: b.id,
        ticketId: 't1',
        ticketKey: `${b.key}-1`,
        ticketTitle: 'x',
        inviteId: null,
        actor: null,
        via: 'app',
        summary: 'Assigned to you',
        groupKey: 't1:assigned',
        count: 1,
        createdAt: Date.now(),
        readAt: null,
        archivedAt: null,
        snoozedUntil: null,
      });
    const feed = (await rest(key, 'GET', '/v1/events')).body as {
      data: { id: string; type: string }[];
      next_cursor: string;
    };
    expect(feed.data).toEqual([
      expect.objectContaining({ id: 'n1', type: 'assigned', acked_at: null }),
    ]);
    expect(
      (await rest(key, 'POST', '/v1/events/ack', { upTo: feed.next_cursor })).body,
    ).toMatchObject({ acked: 1 });
    expect((await db().collection(paths.inbox(owner.uid)).doc('n1').get()).get('readAt')).toEqual(
      expect.any(Number),
    );
  });
});

// ─── MCP with an agent token ─────────────────────────────────────────────────

async function mcpClient(token: string): Promise<Client> {
  const app = await createApp();
  const client = new Client({ name: 'orchestrator', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: ((url: string | URL, init?: RequestInit) =>
      app.request(String(url), init)) as typeof fetch,
  });
  await client.connect(transport);
  return client;
}

const parsed = <T>(r: unknown): T =>
  JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as T;

describe('MCP with an agent token', () => {
  it('whoami → list_my_tickets → upload .md and .html → post_message → get_events / ack_events', async () => {
    bytesFiles();
    const { owner, b, agentId, agent } = await agentBoard();
    const { key: ownerKey } = await apiKeyFor(owner, [...SCOPE_PRESETS.everything], b.id);
    const t = (
      await rest(ownerKey, 'POST', '/v1/tickets', { title: 'Design doc', assignees: [agentId] })
    ).body as { key: string; id: string };
    const ev = await seedAgentEvent(agentId, {
      boardId: b.id,
      ticketId: t.id,
      ticketKey: t.key,
      actor: owner.uid,
    });

    const { key } = await agentKeyFor(owner, agentId, [...SCOPE_PRESETS.worker], b.id);
    const client = await mcpClient(key);

    // Scopes shape the tool list: a Worker cannot create or assign.
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'whoami',
        'list_my_tickets',
        'upload_file',
        'post_message',
        'read_file',
        'get_events',
        'ack_events',
      ]),
    );
    expect(names).not.toContain('create_ticket');
    expect(names).not.toContain('assign_ticket');
    const hidden = await client
      .callTool({ name: 'create_ticket', arguments: { title: 'x' } })
      .catch((e: Error) => ({ isError: true, e }));
    expect((hidden as { isError?: boolean }).isError).toBe(true);

    const me = parsed<{
      principal: { id: string; kind: string; system_prompt: string };
      via: string;
    }>(await client.callTool({ name: 'whoami', arguments: {} }));
    expect(me.principal).toMatchObject({
      id: agentId,
      kind: 'agent',
      system_prompt: agent.systemPrompt,
    });
    expect(me.via).toBe('mcp');

    const mine = parsed<{ tickets: { key: string; assignees: string[] }[] }>(
      await client.callTool({ name: 'list_my_tickets', arguments: {} }),
    );
    expect(mine.tickets.map((x) => x.key)).toEqual([t.key]);
    expect(mine.tickets[0]!.assignees).toEqual(['Builder (agent)']);

    const md = parsed<{ fileId: string; kind: string }>(
      await client.callTool({
        name: 'upload_file',
        arguments: { key: t.key, name: 'plan.md', text: '# Plan\n\n1. Build it' },
      }),
    );
    const html = parsed<{ fileId: string; kind: string }>(
      await client.callTool({
        name: 'upload_file',
        arguments: { key: t.key, name: 'report.html', text: '<h1>Report</h1>' },
      }),
    );
    expect([md.kind, html.kind]).toEqual(['markdown', 'html']);
    const bad = await client.callTool({
      name: 'upload_file',
      arguments: { key: t.key, name: 'x.md' },
    });
    expect(bad.isError).toBe(true);

    const read = parsed<{ content: string }>(
      await client.callTool({ name: 'read_file', arguments: { fileId: html.fileId } }),
    );
    expect(read.content).toBe('<h1>Report</h1>');

    const msg = await client.callTool({
      name: 'post_message',
      arguments: {
        key: t.key,
        markdown: 'Plan and report attached.',
        attachments: [md.fileId, html.fileId],
      },
    });
    expect(msg.isError).toBeFalsy();
    const m = parsed<{
      author: { id: string; kind: string };
      via: string;
      body_md: string;
      attachments: { id: string }[];
    }>(msg);
    expect(m).toMatchObject({
      author: { id: agentId, kind: 'agent' },
      via: 'mcp',
      body_md: 'Plan and report attached.',
    });
    if (messagePostTakesFileIds)
      expect(m.attachments.map((a) => a.id).sort()).toEqual([md.fileId, html.fileId].sort());

    const events = parsed<{ data: { id: string; ticket_key: string }[]; next_cursor: string }>(
      await client.callTool({ name: 'get_events', arguments: {} }),
    );
    expect(events.data.map((e) => e.id)).toContain(ev);
    const acked = parsed<{ acked: number }>(
      await client.callTool({ name: 'ack_events', arguments: { upTo: events.next_cursor } }),
    );
    expect(acked.acked).toBeGreaterThanOrEqual(1);
    const after = parsed<{ data: unknown[] }>(
      await client.callTool({ name: 'get_events', arguments: { cursor: events.next_cursor } }),
    );
    expect(after.data).toEqual([]);

    // Resources.
    const res = await client.readResource({ uri: `ticket://${t.key}` });
    const text = (res.contents[0] as { text: string }).text;
    expect(text).toContain(`# ${t.key} · Design doc`);
    expect(text).toContain('Builder (agent)');
    expect(text).toContain('Plan and report attached.');
    const file = await client.readResource({ uri: `file://${md.fileId}` });
    expect((file.contents[0] as { text: string }).text).toBe('# Plan\n\n1. Build it');
    const schema = await client.readResource({ uri: 'board://schema' });
    expect(JSON.parse((schema.contents[0] as { text: string }).text)).toMatchObject({
      key: b.key,
      stages: expect.any(Array),
    });

    await client.close();
  });

  it('a read-only agent token sees only read tools and cannot write', async () => {
    const { owner, b, agentId } = await agentBoard();
    const { key } = await agentKeyFor(owner, agentId, [...SCOPE_PRESETS.readOnly], b.id, 'ro');
    const client = await mcpClient(key);
    const names = (await client.listTools()).tools.map((x) => x.name).sort();
    // get_question is a READ tool (comments:read), so a read-only token does see it (§L4).
    for (const n of names)
      expect([
        'whoami',
        'list_boards',
        'get_board',
        'list_my_tickets',
        'search_tickets',
        'get_ticket',
        'get_messages',
        'read_file',
        'get_events',
        'ack_events',
        'get_question',
      ]).toContain(n);
    expect(names).not.toContain('post_message');
    await client.close();
  });

  it('a person-token owner call is attributed to the person', async () => {
    const { owner, b } = await agentBoard();
    const { key } = await apiKeyFor(owner, [...SCOPE_PRESETS.everything], b.id);
    const client = await mcpClient(key);
    const created = parsed<{ key: string }>(
      await client.callTool({
        name: 'create_ticket',
        arguments: { title: 'From MCP', assignees: ['me'] },
      }),
    );
    const me = parsed<{ principal: { kind: string; id: string } }>(
      await client.callTool({ name: 'whoami', arguments: {} }),
    );
    expect(me.principal).toMatchObject({ kind: 'user', id: owner.uid });
    const mine = parsed<{ tickets: { key: string }[] }>(
      await client.callTool({ name: 'list_my_tickets', arguments: {} }),
    );
    expect(mine.tickets.map((x) => x.key)).toEqual([created.key]);
    await client.close();
  });
});

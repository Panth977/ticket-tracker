/**
 * 'Connecting Claude over MCP' (platform/flows.json): discovery from the
 * 401, dynamic client registration, consent, PKCE, refresh rotation with
 * reuse detection, revocation — then a real MCP SDK client round trip
 * against /mcp, every change attributed 'via mcp' with the human as actor.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { paths, type Message, type Ticket } from '@tm/shared';
import { createApp } from '../../src/http/app.js';
import { db } from '../../src/runtime/firebase.js';
import { call, request, setupEmulators, type TestUser } from '../harness/index.js';
import { people, seedBoard } from '../tickets/helpers.js';
import { msgsOf } from '../tickets/store.js';
import {
  consent,
  oauthTokens,
  pkce,
  REDIRECT,
  registerClient,
  rest,
  tokenRequest,
} from './helpers.js';

setupEmulators();

describe('discovery', () => {
  it('/mcp without a token answers 401 naming the protected-resource metadata, which names the auth server', async () => {
    const r = await request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(401);
    const m = /resource_metadata="([^"]+)"/.exec(r.headers.get('www-authenticate') ?? '');
    expect(m).toBeTruthy();
    const url = new URL(m![1]!);
    expect(url.pathname).toBe('/.well-known/oauth-protected-resource/mcp');

    const prm = await request(url.pathname);
    const meta = prm.body as { resource: string; authorization_servers: string[] };
    expect(meta.resource).toMatch(/\/mcp$/);
    const as = await request('/.well-known/oauth-authorization-server');
    expect(as.body).toMatchObject({
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
    expect((as.body as { registration_endpoint: string }).registration_endpoint).toMatch(
      /\/oauth\/register$/,
    );
  });
});

describe('OAuth 2.1', () => {
  it('authorize validates and sends the browser to the consent screen', async () => {
    const clientId = await registerClient('Cursor');
    const { challenge } = pkce();
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'tickets:read',
      state: 'x',
    });
    const ok = await request(`/oauth/authorize?${q}`, { redirect: 'manual' });
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toMatch(/\/oauth\/consent\?/);
    // An unregistered redirect is an error page, never a redirect (no open redirector).
    const bad = await request(
      `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: 'https://evil.example/cb' })}`,
    );
    expect(bad.status).toBe(400);
    // No PKCE → back to the client with ?error=
    const noPkce = await request(
      `/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code' })}`,
      { redirect: 'manual' },
    );
    expect(noPkce.status).toBe(302);
    expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe(
      'invalid_request',
    );
  });

  it('consent info names the client; code → tokens with PKCE; code is single use; wrong verifier fails', async () => {
    const { u } = await people('u');
    const clientId = await registerClient('Claude');
    const info = await request('/oauth/consent/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${u.token}` },
      body: JSON.stringify({ client_id: clientId, redirect_uri: REDIRECT }),
    });
    expect(info.body).toMatchObject({ clientName: 'Claude' });

    const { verifier, challenge } = pkce();
    const code = await consent(u, clientId, challenge, 'tickets:read');
    const wrong = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: pkce().verifier,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ error: 'invalid_grant' });
    // …and the failed attempt consumed the code.
    const late = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(late.body).toMatchObject({ error: 'invalid_grant' });

    const code2 = await consent(u, clientId, challenge, 'tickets:read');
    const good = await tokenRequest({
      grant_type: 'authorization_code',
      code: code2,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(good.status).toBe(200);
    // 'tickets:read' is read with its phase-1 meaning (it also read the board and files).
    expect(good.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'board:read tickets:read files:read',
    });
    const me = await rest((good.body as { access_token: string }).access_token, 'GET', '/v1/me');
    expect(me.body).toMatchObject({
      principal: { kind: 'user', id: u.uid },
      via: 'integration',
      scopes: ['board:read', 'tickets:read', 'files:read'],
      token: null,
    });
  });

  it('refresh rotates; presenting a used refresh token revokes the whole grant', async () => {
    const { u } = await people('u');
    const t = await oauthTokens(u, 'tickets:read boards:read');
    const r1 = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: t.clientId,
    });
    expect(r1.status).toBe(200);
    const t2 = r1.body as { access_token: string; refresh_token: string };
    expect(t2.refresh_token).not.toBe(t.refresh_token);
    expect((await rest(t2.access_token, 'GET', '/v1/me')).status).toBe(200);

    // The old one comes back: theft. Everything issued under the grant dies.
    const reuse = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: t.clientId,
    });
    expect(reuse.body).toMatchObject({ error: 'invalid_grant' });
    expect((await rest(t2.access_token, 'GET', '/v1/me')).status).toBe(401);
    const r3 = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: t2.refresh_token,
      client_id: t.clientId,
    });
    expect(r3.body).toMatchObject({ error: 'invalid_grant' });
    expect((await db().doc(paths.oauthGrant(u.uid, t.clientId)).get()).exists).toBe(false);
  });

  it('revoke and grantRevoke', async () => {
    const { u } = await people('u');
    const t = await oauthTokens(u, 'boards:read');
    const rv = await request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t.access_token, client_id: t.clientId }).toString(),
    });
    expect(rv.status).toBe(200);
    expect((await rest(t.access_token, 'GET', '/v1/me')).status).toBe(401);

    const t2 = await oauthTokens(u, 'boards:read');
    expect((await rest(t2.access_token, 'GET', '/v1/me')).status).toBe(200);
    await call(u, 'grantRevoke', { grantId: t2.clientId });
    expect((await rest(t2.access_token, 'GET', '/v1/me')).status).toBe(401);
    const r = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: t2.refresh_token,
      client_id: t2.clientId,
    });
    expect(r.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('consent can narrow to some boards; boards the person is not on are refused', async () => {
    const { u, v } = await people('u', 'v');
    const b1 = await seedBoard({ admin: u });
    const b2 = await seedBoard({ admin: u });
    const foreign = await seedBoard({ admin: v });
    const clientId = await registerClient();
    await expect(
      consent(u, clientId, pkce().challenge, 'board:read', [foreign.id]),
    ).rejects.toThrow(/400/);
    const t = await oauthTokens(u, 'boards:read', [b1.id]); // a phase-1 name still works
    const boards = await rest(t.access_token, 'GET', '/v1/boards');
    expect((boards.body as { data: { id: string }[] }).data.map((b) => b.id)).toEqual([b1.id]);
    void b2;
  });
});

// ─── MCP ─────────────────────────────────────────────────────────────────────

async function mcpClient(accessToken: string): Promise<Client> {
  const app = await createApp();
  const transport = new StreamableHTTPClientTransport(new URL('http://api.test/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    fetch: ((url: string | URL, init?: RequestInit) =>
      app.request(String(url), init)) as typeof fetch,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const parsed = <T>(r: unknown) => JSON.parse(text(r)) as T;

describe('MCP round trip (SDK client)', () => {
  let user: TestUser;

  it('lists tools, creates / reads / updates / comments / links, attributed via mcp', async () => {
    const { panth, priya } = await people('panth', 'priya');
    user = panth;
    const b = await seedBoard({ admin: panth, editors: [priya] });
    // Phase-1 scope names, as an older client asks for them: expanded to the new vocabulary.
    const t = await oauthTokens(
      panth,
      'boards:read tickets:read tickets:write comments:read comments:write members:read',
      null,
      'Claude',
    );
    const client = await mcpClient(t.access_token);

    const tools = await client.listTools();
    const names = tools.tools.map((x) => x.name).sort();
    // get_question rides on comments:read (§L4); the phase-3 WRITE tools need
    // scopes this old client never asked for, so they stay hidden.
    expect(names).toEqual([
      'assign_ticket',
      'create_ticket',
      'get_board',
      'get_messages',
      'get_question',
      'get_ticket',
      'link_tickets',
      'list_boards',
      'list_my_tickets',
      'move_ticket',
      'post_message',
      'read_file',
      'search_tickets',
      'update_ticket',
      'upload_file',
      'whoami',
    ]);
    expect(tools.tools.find((x) => x.name === 'get_ticket')!.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });

    const boards = parsed<{ key: string; stages: { name: string }[] }[]>(
      await client.callTool({ name: 'list_boards', arguments: {} }),
    );
    expect(boards.map((x) => x.key)).toContain(b.key);

    const parent = parsed<{ key: string; id: string }>(
      await client.callTool({
        name: 'create_ticket',
        arguments: {
          board: b.key,
          title: 'Login is broken',
          assignees: ['me'],
          due: '2020-01-01',
          priority: 'High',
        },
      }),
    );
    expect(parent.key).toBe(`${b.key}-1`);
    const child = parsed<{ key: string; id: string; description_md: string }>(
      await client.callTool({
        name: 'create_ticket',
        arguments: {
          board: b.key,
          title: 'Split: redirect',
          description: `Part of #${parent.key}, cc @${priya.email}`,
          stage: 'Doing',
        },
      }),
    );
    expect(child.description_md).toContain(`#${parent.key}`);
    const stored = (await db().doc(paths.ticket(b.id, child.id)).get()).data() as Ticket;
    expect(stored.createdVia).toBe('mcp');
    expect(stored.createdBy).toBe(panth.uid);
    expect(stored.refs).toContain(parent.id);

    // Names that do not exist come back as a tool error listing what does.
    const bad = await client.callTool({
      name: 'update_ticket',
      arguments: { key: child.key, stage: 'Shipped' },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('To do, Doing, Review, Done');

    const moved = parsed<{ stage: { name: string } }>(
      await client.callTool({
        name: 'update_ticket',
        arguments: { key: child.key, stage: 'review' },
      }),
    );
    expect(moved.stage.name).toBe('Review');

    const cm = parsed<{ via: string; body_md: string }>(
      await client.callTool({
        name: 'post_message',
        arguments: { key: parent.key, markdown: 'On it **now**' },
      }),
    );
    expect(cm.via).toBe('mcp');
    const msgs = (await msgsOf(b.id, parent.id)) as Message[];
    const comment = msgs.find((m) => m.kind === 'comment')!;
    expect(comment).toMatchObject({ via: 'mcp', authorUid: panth.uid });

    const linked = parsed<{ links: { type: string; key: string }[] }>(
      await client.callTool({
        name: 'link_tickets',
        arguments: { from: child.key, to: parent.key, type: 'blocks' },
      }),
    );
    expect(linked.links).toEqual([{ type: 'blocks', key: parent.key }]);

    const got = parsed<{ key: string; links: unknown[]; messages: { body_md: string }[] }>(
      await client.callTool({ name: 'get_ticket', arguments: { key: parent.key } }),
    );
    expect(got.links).toEqual([{ type: 'blockedBy', key: child.key }]);
    expect(got.messages.some((m) => m.body_md.includes('On it'))).toBe(true);

    const work = parsed<{ overdue: string[]; tickets: { key: string }[] }>(
      await client.callTool({ name: 'list_my_tickets', arguments: { board: b.key } }),
    );
    expect(work.tickets.map((x) => x.key)).toEqual([parent.key]);
    expect(work.overdue).toEqual([parent.key]);

    const search = parsed<{ tickets: { key: string }[] }>(
      await client.callTool({
        name: 'search_tickets',
        arguments: { board: b.key, query: 'redirect' },
      }),
    );
    expect(search.tickets.map((x) => x.key)).toEqual([child.key]);
    const byStage = parsed<{ tickets: { key: string }[] }>(
      await client.callTool({ name: 'search_tickets', arguments: { stage: 'Review' } }),
    );
    expect(byStage.tickets.map((x) => x.key)).toEqual([child.key]);

    const board = parsed<{ members: { email: string }[] }>(
      await client.callTool({ name: 'get_board', arguments: { board: b.key } }),
    );
    expect(board.members.map((m) => m.email).sort()).toEqual([panth.email, priya.email].sort());

    // Resources and prompts.
    const res = await client.readResource({ uri: `ticket://${parent.key}` });
    expect((res.contents[0] as { text: string }).text).toContain(
      `# ${parent.key} · Login is broken`,
    );
    const schema = await client.readResource({ uri: `board://${b.key}/schema` });
    expect(
      JSON.parse((schema.contents[0] as { text: string }).text).stages.map(
        (s: { name: string }) => s.name,
      ),
    ).toEqual(['To do', 'Doing', 'Review', 'Done']);
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((x) => x.uriTemplate).sort()).toEqual([
      'board://{key}/schema',
      'file://{fileId}',
      'ticket://{key}',
    ]);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual(['standup_summary', 'triage_board']);
    const p = await client.getPrompt({ name: 'triage_board', arguments: { board: b.key } });
    expect(JSON.stringify(p.messages)).toContain(b.key);

    await client.close();
  });

  it('a read-only grant cannot write: the tool answers an error, nothing changes', async () => {
    const { u } = await people('u');
    const b = await seedBoard({ admin: u });
    const t = await oauthTokens(u, 'board:read tickets:read');
    const client = await mcpClient(t.access_token);
    // Hidden from tools/list, and refused if called anyway.
    expect((await client.listTools()).tools.map((x) => x.name)).not.toContain('create_ticket');
    const r = await client
      .callTool({ name: 'create_ticket', arguments: { board: b.key, title: 'nope' } })
      .catch((e: Error) => ({ isError: true, e }));
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect((await db().collection(paths.tickets(b.id)).get()).size).toBe(0);
    await client.close();
    void user;
  });

  it('board tokens (API keys) are accepted at /mcp too (phase 2); a revoked one is 401; GET is 405', async () => {
    const { u } = await people('u');
    const b = await seedBoard({ admin: u });
    const { key, keyId } = await call(u, 'apiKeyCreate', {
      name: 'k',
      scopes: ['tickets:read'],
      boardId: b.id,
    });
    const list = () =>
      request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    const r = await list();
    expect(r.status).toBe(200);
    await call(u, 'apiKeyRevoke', { keyId });
    expect((await list()).status).toBe(401);
    const t = await oauthTokens(u, 'tickets:read');
    const g = await request('/mcp', { headers: { authorization: `Bearer ${t.access_token}` } });
    expect(g.status).toBe(405);
  });
});

/**
 * ORCH-73 — token_create / token_list / token_revoke: a person's own assistant
 * (an account token with agents:write) mints and revokes tokens for THEIR
 * AGENTS, and nothing more. apiKeyCreate / apiKeyRevoke stay on the deny list.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { paths, SCOPE_PRESETS, type ApiKey, type Scope } from '@tm/shared';
import { createApp } from '../../src/http/app.js';
import { db } from '../../src/runtime/firebase.js';
import { call, setupEmulators } from '../harness/index.js';
import { people, seedBoard } from '../tickets/helpers.js';
import { agentTokenFor, apiKeyFor, rest, seedAgent } from './helpers.js';

setupEmulators();

async function mcpClient(token: string): Promise<Client> {
  const app = await createApp();
  const client = new Client({ name: 'manager', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: ((url: string | URL, init?: RequestInit) =>
      app.request(String(url), init)) as typeof fetch,
  });
  await client.connect(transport);
  return client;
}

type Res = { isError?: boolean; content: { text: string }[] };
const tool = async (c: Client, name: string, args: Record<string, unknown>) =>
  (await c.callTool({ name, arguments: args })) as Res;
const body = <T>(r: Res): T => JSON.parse(r.content[0]!.text) as T;

async function scene() {
  const { owner, priya } = await people('owner', 'priya');
  const mgr = await seedBoard({ admin: owner });
  const { id: agentId } = await seedAgent(owner, { name: 'Manager Main', boardId: mgr.id });
  const account = await call(owner, 'apiKeyCreate', {
    name: 'Manager',
    kind: 'account' as const,
    scopes: [...SCOPE_PRESETS.fullAccount] as Scope[],
  });
  return { owner, priya, mgr, agentId, account };
}

describe('ORCH-73 token_create', () => {
  it('mints a Worker board token for an agent named by name, recorded as made by the key', async () => {
    const { owner, mgr, agentId, account } = await scene();
    const c = await mcpClient(account.key);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['token_create', 'token_list', 'token_revoke']));
    // Hold-to-confirm in clients that tier by destructiveHint (Manager).
    const tools = (await c.listTools()).tools;
    expect(tools.find((t) => t.name === 'token_create')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'token_revoke')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'token_list')?.annotations?.readOnlyHint).toBe(true);

    const r = await tool(c, 'token_create', {
      name: 'orch-mgr',
      agent: 'manager main',
      board: mgr.key,
    });
    expect(r.isError).toBeFalsy();
    const out = body<{
      key: string;
      keyId: string;
      kind: string;
      scopes: Scope[];
      boardId: string;
    }>(r);
    expect(out.key).toMatch(/^tm_live_/);
    expect(out.kind).toBe('board');
    expect(out.boardId).toBe(mgr.id);
    expect([...out.scopes].sort()).toEqual([...SCOPE_PRESETS.worker].sort());

    const row = (await db().doc(paths.apiKey(owner.uid, out.keyId)).get()).data() as ApiKey;
    expect(row.actsAs).toEqual({ kind: 'agent', id: agentId });
    expect(row.mintedByKeyId).toBe(account.keyId);

    // The new token works, as the agent.
    const me = (await rest(out.key, 'GET', '/v1/me')).body as { id?: string; kind?: string };
    expect(JSON.stringify(me)).toContain(agentId);
  });

  it('an agent token by default keeps the agent’s other tokens alive', async () => {
    const { owner, agentId, account } = await scene();
    const old = await agentTokenFor(owner, agentId);
    const c = await mcpClient(account.key);
    const out = body<{ kind: string; rotated: number }>(
      await tool(c, 'token_create', { name: 'orch-mgr-2', agent: agentId }),
    );
    expect(out.kind).toBe('agent');
    expect(out.rotated).toBe(0);
    const oldRow = (await db().doc(paths.apiKey(owner.uid, old.keyId)).get()).data() as ApiKey;
    expect(oldRow.revokedAt).toBe(null);
  });

  it('refuses someone else’s agent and a board the agent is not on', async () => {
    const { owner, priya, mgr, account } = await scene();
    const { id: theirs } = await seedAgent(priya, { name: 'Theirs' });
    const c = await mcpClient(account.key);
    expect(
      (await tool(c, 'token_create', { name: 'x', agent: theirs, board: mgr.key })).isError,
    ).toBe(true);
    const ops = await seedBoard({ admin: owner });
    expect(
      (await tool(c, 'token_create', { name: 'x', agent: 'Manager Main', board: ops.key })).isError,
    ).toBe(true);
    expect(
      (await tool(c, 'token_create', { name: 'x', agent: 'Nobody', board: mgr.key })).isError,
    ).toBe(true);
  });

  it('is not offered to a token without agents:write, nor to an agent', async () => {
    const { owner, mgr, agentId } = await scene();
    const worker = await apiKeyFor(owner, [...SCOPE_PRESETS.worker] as Scope[], mgr.id);
    const agentTok = await agentTokenFor(owner, agentId, { keepOthers: true });
    for (const k of [worker.key, agentTok.key]) {
      const names = (await (await mcpClient(k)).listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('token_create');
      expect(names).not.toContain('token_revoke');
      expect(names).not.toContain('token_list');
    }
  });
});

describe('ORCH-73 token_list / token_revoke', () => {
  it('lists without secrets, revokes agent tokens, refuses account tokens', async () => {
    const { mgr, account } = await scene();
    const c = await mcpClient(account.key);
    const made = body<{ keyId: string; key: string }>(
      await tool(c, 'token_create', { name: 'orch-mgr', agent: 'Manager Main', board: mgr.key }),
    );

    const list = await tool(c, 'token_list', {});
    expect(list.content[0]!.text).not.toContain(made.key);
    expect(list.content[0]!.text).not.toMatch(/"hash"/);
    const rows = body<{ keyId: string; board: string | null; current: boolean }[]>(list);
    expect(rows.find((x) => x.keyId === made.keyId)?.board).toBe(mgr.key);
    expect(rows.find((x) => x.keyId === account.keyId)?.current).toBe(true);

    expect((await tool(c, 'token_revoke', { keyId: made.keyId })).isError).toBeFalsy();
    expect((await rest(made.key, 'GET', '/v1/me')).status).toBe(401);
    expect(
      body<{ keyId: string }[]>(await tool(c, 'token_list', {})).map((x) => x.keyId),
    ).not.toContain(made.keyId);

    // Its own (account) token: app only.
    expect((await tool(c, 'token_revoke', { keyId: account.keyId })).isError).toBe(true);
    expect((await rest(account.key, 'GET', '/v1/me')).status).toBe(200);
  });
});

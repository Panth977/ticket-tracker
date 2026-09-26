/**
 * PHASE 10 (docs/plan/agents.html §R1–§R2) — ACCOUNT TOKENS: "virtual me".
 *
 * Everything here is about the two promises that make an account token safe
 * enough to hand to Claude:
 *
 *   1. THE DENY LIST. Whatever its scopes, a token can never mint or revoke a
 *      token, touch OAuth grants, or change the account. A leak cannot become
 *      permanent.
 *   2. THE BOARD SET IS LIVE. It is resolved from membership at each call, not
 *      stored on the token. Lose access to a board and the very next request
 *      is refused; join one and it is simply there.
 *
 * Plus the board-agnostic doors of §R2: REST with the board in the path, in a
 * parameter or implied by a ticket key, and MCP with and without `board`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import {
  MCP_TOOLS,
  paths,
  REST_ROUTES,
  SCOPE_PRESETS,
  TOKEN_DENIED_COMMANDS,
  type ApiKey,
  type Scope,
} from '@tm/shared';
import { createApp } from '../../src/http/app.js';
import { db } from '../../src/runtime/firebase.js';
import { call, setupEmulators } from '../harness/index.js';
import { people, seedBoard } from '../tickets/helpers.js';
import { apiKeyFor, rest, seedAgent } from './helpers.js';

setupEmulators();

/** An ACCOUNT token (§R1): no board, acts as the person, account scopes allowed. */
function accountKeyFor(user: Parameters<typeof apiKeyFor>[0], scopes: Scope[], name = 'claude') {
  return call(user, 'apiKeyCreate', { name, kind: 'account' as const, scopes });
}

async function mcpClient(token: string): Promise<Client> {
  const app = await createApp();
  const client = new Client({ name: 'claude', version: '1.0.0' });
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

/** Two boards the owner is on, plus one they are not. */
async function scene() {
  const { owner, priya } = await people('owner', 'priya');
  const eng = await seedBoard({ admin: owner, editors: [priya] });
  const ops = await seedBoard({ admin: owner });
  const theirs = await seedBoard({ admin: priya });
  return { owner, priya, eng, ops, theirs };
}

describe('§R1 creating an account token', () => {
  it('has no board, acts as you, and may carry the account scopes', async () => {
    const { owner } = await scene();
    const { key, keyId } = await accountKeyFor(owner, [...SCOPE_PRESETS.fullAccount] as Scope[]);
    const row = (await db().doc(paths.apiKey(owner.uid, keyId)).get()).data() as ApiKey;

    expect(key).toMatch(/^tm_live_/);
    expect(row.kind).toBe('account');
    expect(row.boardId).toBe(null);
    expect(row.actsAs).toEqual({ kind: 'user', id: owner.uid });
    expect(row.scopes).toEqual(
      expect.arrayContaining(['boards:create', 'boards:admin', 'agents:write', 'invites:write']),
    );
  });

  it('refuses the contradictions: a board, an agent, or account scopes on a board token', async () => {
    const { owner, eng } = await scene();
    const { id: agentId } = await seedAgent(owner, { name: 'Builder', boardId: eng.id });

    // An account token has no board of its own…
    await expect(
      call(owner, 'apiKeyCreate', {
        name: 'x',
        kind: 'account' as const,
        boardId: eng.id,
        scopes: ['board:read'] as Scope[],
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    // …and always acts as you: an agent lives on ONE board.
    await expect(
      call(owner, 'apiKeyCreate', {
        name: 'x',
        kind: 'account' as const,
        actsAs: { kind: 'agent' as const, id: agentId },
        scopes: ['board:read'] as Scope[],
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    // A BOARD token may not carry an account-level scope.
    await expect(
      call(owner, 'apiKeyCreate', {
        name: 'x',
        boardId: eng.id,
        scopes: ['board:read', 'boards:create'] as Scope[],
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('§R1 the deny list: a token may never mint a token', () => {
  it('no door exposes a denied command, and a token cannot reach /api at all', async () => {
    const { owner } = await scene();
    const { key } = await accountKeyFor(owner, [...SCOPE_PRESETS.fullAccount] as Scope[]);

    // Nothing on the deny list has a REST route or an MCP tool of its own…
    const routes = REST_ROUTES.map((r) => r.path.toLowerCase());
    const tools = Object.keys(MCP_TOOLS).map((t) => t.toLowerCase());
    for (const name of TOKEN_DENIED_COMMANDS) {
      const slug = name.toLowerCase();
      expect(routes.some((p) => p.includes(slug))).toBe(false);
      expect(tools.some((t) => t.replace(/_/g, '').includes(slug))).toBe(false);
    }

    // …and /api, where commands live, takes a signed-in SESSION, never a token:
    // the strongest token there is cannot mint another one.
    for (const name of [
      'apiKeyCreate',
      'apiKeyRevoke',
      'accountDelete',
      'sessionRevokeAll',
      'profileUpdate',
    ]) {
      const r = await rest(key, 'POST', `/api/${name}`, {
        name: 'stolen',
        kind: 'account',
        scopes: ['board:read'],
      });
      expect([401, 403, 404]).toContain(r.status);
      // Whatever the door answers, nothing was created.
      expect(r.status).not.toBe(200);
    }
    const keys = await db().collection(paths.apiKeys(owner.uid)).get();
    expect(keys.docs.filter((d) => (d.data() as ApiKey).name === 'stolen')).toHaveLength(0);
  });
});

describe('§R2 REST with an account token', () => {
  it('/v1/me reports the kind and the boards reachable now', async () => {
    const { owner, eng, ops } = await scene();
    const { key } = await accountKeyFor(owner, [...SCOPE_PRESETS.fullAccount] as Scope[]);

    const me = (await rest(key, 'GET', '/v1/me')).body as {
      kind: string;
      board: unknown;
      boards: { key: string }[];
      token: { kind: string; name: string };
      principal: { kind: string; id: string };
    };
    expect(me.kind).toBe('account');
    expect(me.token.kind).toBe('account');
    expect(me.board).toBe(null);
    expect(me.principal).toMatchObject({ kind: 'user', id: owner.uid });
    expect(me.boards.map((b) => b.key).sort()).toEqual([eng.key, ops.key].sort());
  });

  it('names the board in the path, in a parameter, or by ticket key', async () => {
    const { owner, eng, ops } = await scene();
    const { key } = await accountKeyFor(owner, [...SCOPE_PRESETS.fullAccount] as Scope[]);

    // In the path.
    const created = await rest(key, 'POST', `/v1/boards/${eng.key}/tickets`, {
      title: 'From the path',
    });
    expect(created.status).toBe(201);
    const t = created.body as { key: string; board: { key: string } };
    expect(t.board.key).toBe(eng.key);

    // As a parameter…
    const byParam = await rest(key, 'GET', `/v1/tickets?board=${eng.key}`);
    expect(byParam.status).toBe(200);
    expect((byParam.body as { data: { key: string }[] }).data.map((x) => x.key)).toContain(t.key);

    // …and by ticket key, which names its own board.
    const byKey = await rest(key, 'GET', `/v1/tickets/${t.key}`);
    expect(byKey.status).toBe(200);
    expect((byKey.body as { board: { key: string } }).board.key).toBe(eng.key);

    // The nested board route and the flat one answer the same board.
    const nested = (await rest(key, 'GET', `/v1/boards/${eng.key}`)).body as { key: string };
    const flat = (await rest(key, 'GET', `/v1/board?board=${eng.key}`)).body as { key: string };
    expect(nested.key).toBe(eng.key);
    expect(flat.key).toBe(eng.key);

    // With two boards and no board named, the error SAYS which ones exist.
    const vague = await rest(key, 'GET', '/v1/tickets');
    expect(vague.status).toBe(400);
    const detail = JSON.stringify(vague.body);
    expect(detail).toContain(eng.key);
    expect(detail).toContain(ops.key);
  });

  it('a board token is unchanged: it needs no board, and may not name another', async () => {
    const { owner, eng, ops } = await scene();
    const { key } = await apiKeyFor(owner, [...SCOPE_PRESETS.everything] as Scope[], eng.id);

    const me = (await rest(key, 'GET', '/v1/me')).body as {
      kind: string;
      board: { key: string } | null;
    };
    expect(me.kind).toBe('board');
    expect(me.board?.key).toBe(eng.key);

    // No board parameter needed (phase-2 behaviour).
    expect((await rest(key, 'GET', '/v1/tickets')).status).toBe(200);
    // Its own board's key is fine; another board it is on is still 404.
    expect((await rest(key, 'GET', `/v1/tickets?board=${eng.key}`)).status).toBe(200);
    expect((await rest(key, 'GET', `/v1/tickets?board=${ops.key}`)).status).toBe(404);
  });

  it('THE BOARD SET IS LIVE: losing a board takes effect on the next request', async () => {
    const { owner, priya, eng } = await scene();
    // Priya is an editor on ENG; her account token reaches it.
    const { key } = await accountKeyFor(priya, [...SCOPE_PRESETS.worker] as Scope[]);

    expect((await rest(key, 'GET', `/v1/board?board=${eng.key}`)).status).toBe(200);
    const before = (await rest(key, 'GET', '/v1/boards')).body as { data: { key: string }[] };
    expect(before.data.map((b) => b.key)).toContain(eng.key);

    // The admin removes her. NOTHING is done to the token.
    await call(owner, 'boardAccessSet', { boardId: eng.id, people: { [priya.uid]: null } });

    // The very next call is refused — no cached board list to go stale.
    const after = await rest(key, 'GET', `/v1/board?board=${eng.key}`);
    expect([403, 404]).toContain(after.status);
    const boards = (await rest(key, 'GET', '/v1/boards')).body as { data: { key: string }[] };
    expect(boards.data.map((b) => b.key)).not.toContain(eng.key);

    // And the token itself still works — it lost a board, not its life.
    expect((await rest(key, 'GET', '/v1/me')).status).toBe(200);
  });

  it('a board seen for the first time is simply there (nothing to refresh)', async () => {
    const { owner, priya } = await scene();
    const { key } = await accountKeyFor(priya, [...SCOPE_PRESETS.worker] as Scope[]);
    const fresh = await seedBoard({ admin: owner });

    expect(
      ((await rest(key, 'GET', '/v1/boards')).body as { data: { key: string }[] }).data.map(
        (b) => b.key,
      ),
    ).not.toContain(fresh.key);
    // Added to the board the way any membership change adds someone.
    await db()
      .doc(paths.board(fresh.id))
      .update({
        [`access.${priya.uid}`]: 'editor',
        readerUids: [owner.uid, priya.uid],
      });
    const now = (await rest(key, 'GET', '/v1/boards')).body as { data: { key: string }[] };
    expect(now.data.map((b) => b.key)).toContain(fresh.key);
  });
});

describe('§R2 MCP with an account token', () => {
  it('list_boards first, then the same tools with a `board` argument — or a ticket key', async () => {
    const { owner, eng, ops } = await scene();
    const { key } = await accountKeyFor(owner, [...SCOPE_PRESETS.fullAccount] as Scope[]);
    const client = await mcpClient(key);

    const boards = parsed<{ key: string }[]>(
      await client.callTool({ name: 'list_boards', arguments: {} }),
    );
    expect(boards.map((b) => b.key).sort()).toEqual([eng.key, ops.key].sort());

    // tools/list SAYS the difference: board-taking tools ask for `board`.
    const tools = (await client.listTools()).tools;
    const getBoard = tools.find((t) => t.name === 'get_board')!;
    expect(getBoard.description).toMatch(/every board you are on/i);
    // A tool that never needs a board is not given the sentence.
    expect(tools.find((t) => t.name === 'get_ticket')!.description).not.toMatch(
      /every board you are on/i,
    );

    // WITH `board`.
    const board = parsed<{ key: string }>(
      await client.callTool({ name: 'get_board', arguments: { board: ops.key } }),
    );
    expect(board.key).toBe(ops.key);

    // WITHOUT `board`, and with more than one to choose from: a useful error.
    const vague = (await client.callTool({ name: 'get_board', arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(vague.isError).toBe(true);
    expect(vague.content[0]!.text).toContain(eng.key);

    // A ticket key names its own board, so no argument is needed.
    const t = parsed<{ key: string }>(
      await client.callTool({
        name: 'create_ticket',
        arguments: { board: eng.key, title: 'Via MCP' },
      }),
    );
    const got = parsed<{ key: string; board: { key: string } }>(
      await client.callTool({ name: 'get_ticket', arguments: { key: t.key } }),
    );
    expect(got.board.key).toBe(eng.key);

    await client.close();
  });

  it('a board token still needs no `board`, and is told nothing new', async () => {
    const { owner, eng } = await scene();
    const { key } = await apiKeyFor(owner, [...SCOPE_PRESETS.everything] as Scope[], eng.id);
    const client = await mcpClient(key);

    const board = parsed<{ key: string }>(
      await client.callTool({ name: 'get_board', arguments: {} }),
    );
    expect(board.key).toBe(eng.key);
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === 'get_board')!.description).not.toMatch(
      /every board you are on/i,
    );

    await client.close();
  });
});

describe('§R1 attribution is unchanged', () => {
  it("a change made with an account token reads 'you, via token <name>'", async () => {
    const { owner, eng } = await scene();
    const { key } = await accountKeyFor(owner, [...SCOPE_PRESETS.fullAccount] as Scope[], 'claude');
    const t = (await rest(key, 'POST', `/v1/boards/${eng.key}/tickets`, { title: 'Attributed' }))
      .body as { key: string };
    const posted = await rest(key, 'POST', `/v1/tickets/${t.key}/messages`, {
      body_markdown: 'Done.',
    });
    expect(posted.status).toBe(201);
    const m = posted.body as {
      author: { id: string; kind: string };
      via: string;
      via_token: string;
    };
    expect(m.author).toMatchObject({ id: owner.uid, kind: 'user' });
    expect(m.via).toBe('api');
    expect(m.via_token).toBe('claude');
  });
});

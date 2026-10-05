/**
 * §AA1–§AA2 (docs/plan/agents.html §AA) — ONE TOKEN PER AGENT; THE ROLE IS THE
 * PERMISSION.
 *
 * An agent token says who the agent is and nothing else. These tests hold the
 * promises that follow from that, through the real doors (REST and MCP):
 *
 *   - it resolves with no board at all, and reaches every board the agent is
 *     on, as that stands at each call — cut by the agent's ROLE there, never
 *     by a checkbox list
 *   - which board: implied when there is one, named when there are several,
 *     and the old board of a converted token when none is named
 *   - leaving a board does not kill the token; archiving the agent does
 *   - generating a new token replaces the old (unless keepOthers)
 *   - an agent may be a board ADMIN, and still never manages people, agents,
 *     invites, boards or tokens
 *   - a token from before §AA (a board token acting as an agent) still works,
 *     unconverted
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import {
  AGENT_TOKEN_SCOPES,
  paths,
  type ApiKey,
  type Board,
  type Scope,
  type Webhook,
} from '@tm/shared';
import { agentKeyDoc } from '../../src/platform/apiKeyMint.js';
import { sha256hex } from '../../src/platform/crypto.js';
import { createApp } from '../../src/http/app.js';
import { db } from '../../src/runtime/firebase.js';
import { asAgent, makeAgent, type TestAgent } from '../agents/helpers.js';
import { call, setupEmulators, uniq, type TestUser } from '../harness/index.js';
import { people, seedBoard, STAGES, type SeededBoard } from '../tickets/helpers.js';
import { agentKeyFor, agentTokenFor, rest } from './helpers.js';

setupEmulators();

const keyRow = async (owner: TestUser, keyId: string) =>
  (await db().doc(paths.apiKey(owner.uid, keyId)).get()).data() as ApiKey;
const boardDoc = async (id: string) => (await db().doc(paths.board(id)).get()).data() as Board;

async function mcpClient(token: string): Promise<Client> {
  const app = await createApp();
  const client = new Client({ name: 'orch', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: ((url: string | URL, init?: RequestInit) =>
      app.request(String(url), init)) as typeof fetch,
  });
  await client.connect(transport);
  return client;
}
const text = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text;

/** A ticket on a board, made by its admin. */
async function ticketOn(admin: TestUser, board: SeededBoard, title = 'A ticket'): Promise<string> {
  const { key } = await call(admin, 'ticketCreate', { boardId: board.id, title });
  return key;
}

/** A converted token (§AA6): what the migration leaves behind for an old board token. */
async function convertedToken(owner: TestUser, agentId: string, defaultBoardId: string) {
  const key = `tm_live_${uniq('conv')}`.padEnd(40, 'x');
  const keyId = uniq('key');
  await db()
    .doc(paths.apiKey(owner.uid, keyId))
    .set(
      agentKeyDoc({
        name: 'orch-old-board-token',
        agentId,
        prefix: key.slice(0, 12),
        hash: sha256hex(key),
        now: Date.now(),
        defaultBoardId,
      }),
    );
  return { key, keyId };
}

describe('§AA1 creating the agent token', () => {
  it('names the agent and nothing else: no board, the fixed scopes, no default board', async () => {
    const { owner } = await people('owner');
    const agent = await makeAgent(owner); // on NO board yet — it does not need one
    const { key, keyId, rotated } = await agentTokenFor(owner, agent.id, { name: 'Builder' });
    const row = await keyRow(owner, keyId);

    expect(key).toMatch(/^tm_live_/);
    expect(rotated).toBe(0);
    expect(row.kind).toBe('agent');
    expect(row.boardId).toBe(null);
    expect(row.defaultBoardId).toBeUndefined();
    expect(row.actsAs).toEqual({ kind: 'agent', id: agent.id });
    expect([...row.scopes].sort()).toEqual([...AGENT_TOKEN_SCOPES].sort());
    // No account scope: the token can never create boards, agents or invites.
    for (const s of ['boards:create', 'boards:admin', 'agents:write', 'invites:write'])
      expect(row.scopes).not.toContain(s);
  });

  it("refuses someone else's agent (404), an archived one, a board and a scope list", async () => {
    const { owner, other } = await people('owner', 'other');
    const mine = await makeAgent(owner);
    const theirs = await makeAgent(other);
    const board = await seedBoard({ admin: owner });
    const actsAs = { kind: 'agent' as const, id: mine.id };

    await expect(agentTokenFor(owner, theirs.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      call(owner, 'apiKeyCreate', { name: 'x', kind: 'agent', actsAs, boardId: board.id }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      call(owner, 'apiKeyCreate', {
        name: 'x',
        kind: 'agent',
        actsAs,
        scopes: ['board:read'] as Scope[],
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      call(owner, 'apiKeyCreate', { name: 'x', kind: 'agent' }),
    ).rejects.toMatchObject({ code: 'invalid' });

    await call(owner, 'agentArchive', { agentId: mine.id });
    await expect(agentTokenFor(owner, mine.id)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('generating a new one REPLACES the old (rotated) — every other live token of that agent', async () => {
    const { owner } = await people('owner');
    const board = await seedBoard({ admin: owner });
    const agent = await makeAgent(owner, { boardId: board.id });
    const other = await makeAgent(owner, { boardId: board.id, name: 'Other' });

    const first = await agentTokenFor(owner, agent.id);
    // A token from before §AA acts as the same agent: it is replaced as well.
    const legacy = await agentKeyFor(owner, agent.id, ['board:read'], board.id);
    // Another agent's token is none of this one's business.
    const bystander = await agentTokenFor(owner, other.id);
    expect((await rest(first.key, 'GET', '/v1/me')).status).toBe(200);

    const second = await agentTokenFor(owner, agent.id);
    expect(second.rotated).toBe(2);
    expect(await keyRow(owner, first.keyId)).toMatchObject({ revokedReason: 'rotated' });
    expect(await keyRow(owner, legacy.keyId)).toMatchObject({ revokedReason: 'rotated' });
    expect((await keyRow(owner, first.keyId)).revokedAt).not.toBeNull();
    expect((await keyRow(owner, bystander.keyId)).revokedAt).toBeNull();

    // The old one stops working on its very next call; the new one works.
    expect((await rest(first.key, 'GET', '/v1/me')).status).toBe(401);
    expect((await rest(legacy.key, 'GET', '/v1/me')).status).toBe(401);
    expect((await rest(second.key, 'GET', '/v1/me')).status).toBe(200);
    expect((await rest(bystander.key, 'GET', '/v1/me')).status).toBe(200);
  });

  it('keepOthers keeps them all working beside the new one', async () => {
    const { owner } = await people('owner');
    const agent = await makeAgent(owner);
    const first = await agentTokenFor(owner, agent.id);
    const second = await agentTokenFor(owner, agent.id, { keepOthers: true });

    expect(second.rotated).toBe(0);
    expect((await keyRow(owner, first.keyId)).revokedAt).toBeNull();
    expect((await rest(first.key, 'GET', '/v1/me')).status).toBe(200);
    expect((await rest(second.key, 'GET', '/v1/me')).status).toBe(200);
  });
});

describe('§AA1 what stands behind it', () => {
  it('resolves with no board at all', async () => {
    const { owner } = await people('owner');
    const agent = await makeAgent(owner, { name: 'Loner' });
    const { key } = await agentTokenFor(owner, agent.id);

    const me = await rest(key, 'GET', '/v1/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      kind: 'agent',
      board: null,
      boards: [],
      default_board: null,
      role: null,
      principal: { kind: 'agent', id: agent.id, name: 'Loner' },
      owner: { id: owner.uid },
      token: { kind: 'agent' },
    });
    expect([...(me.body as { scopes: string[] }).scopes].sort()).toEqual(
      [...AGENT_TOKEN_SCOPES].sort(),
    );
    expect((await rest(key, 'GET', '/v1/boards')).body).toMatchObject({ data: [] });
    // A board call has nowhere to go — and says so, rather than 401.
    const t = await rest(key, 'GET', '/v1/tickets');
    expect(t.status).toBe(400);
    expect(JSON.stringify(t.body)).toMatch(/not on any board/);
  });

  it('boardAgentSet keeps agentIds derived from access; the token finds its boards through it', async () => {
    const { owner } = await people('owner');
    const a = await seedBoard({ admin: owner });
    const b = await seedBoard({ admin: owner });
    const agent = await makeAgent(owner);
    const { key } = await agentTokenFor(owner, agent.id);

    await call(owner, 'boardAgentSet', { boardId: a.id, agentId: agent.id, role: 'viewer' });
    expect((await boardDoc(a.id)).agentIds).toEqual([agent.id]);
    // readerUids is still people only (the rules read it; an agent never signs in).
    expect((await boardDoc(a.id)).readerUids).toEqual([owner.uid]);
    await call(owner, 'boardAgentSet', { boardId: b.id, agentId: agent.id, role: 'editor' });

    const boards = (await rest(key, 'GET', '/v1/boards')).body as { data: { key: string }[] };
    expect(boards.data.map((x) => x.key).sort()).toEqual([a.key, b.key].sort());

    await call(owner, 'boardAgentSet', { boardId: a.id, agentId: agent.id, role: null });
    expect((await boardDoc(a.id)).agentIds).toEqual([]);
    const after = (await rest(key, 'GET', '/v1/boards')).body as { data: { key: string }[] };
    expect(after.data.map((x) => x.key)).toEqual([b.key]);
  });

  it('leaving ONE board does not kill the token; that board becomes a 404', async () => {
    const { owner } = await people('owner');
    const a = await seedBoard({ admin: owner });
    const b = await seedBoard({ admin: owner });
    const agent = await makeAgent(owner, { boardId: a.id });
    await call(owner, 'boardAgentSet', { boardId: b.id, agentId: agent.id, role: 'editor' });
    const { key, keyId } = await agentTokenFor(owner, agent.id);
    const onA = await ticketOn(owner, a);
    const onB = await ticketOn(owner, b);
    expect((await rest(key, 'GET', `/v1/tickets/${onA}`)).status).toBe(200);

    await call(owner, 'boardAgentSet', { boardId: a.id, agentId: agent.id, role: null });

    expect((await keyRow(owner, keyId)).revokedAt).toBeNull();
    expect((await rest(key, 'GET', '/v1/me')).status).toBe(200);
    expect((await rest(key, 'GET', `/v1/tickets/${onA}`)).status).toBe(404);
    expect((await rest(key, 'GET', `/v1/boards/${a.key}`)).status).toBe(404);
    expect((await rest(key, 'GET', `/v1/tickets/${onB}`)).status).toBe(200);
  });

  it('archiving the agent DOES kill it (agentArchived), whatever boards it was on', async () => {
    const { owner } = await people('owner');
    const a = await seedBoard({ admin: owner });
    const agent = await makeAgent(owner, { boardId: a.id });
    const { key, keyId } = await agentTokenFor(owner, agent.id);
    expect((await rest(key, 'GET', '/v1/me')).status).toBe(200);

    const res = await call(owner, 'agentArchive', { agentId: agent.id });
    expect(res.tokensRevoked).toBe(1);
    expect(await keyRow(owner, keyId)).toMatchObject({ revokedReason: 'agentArchived' });
    expect((await rest(key, 'GET', '/v1/me')).status).toBe(401);
  });

  it("the owner leaving a board takes the agent's reach there with them", async () => {
    const { admin, owner } = await people('admin', 'owner');
    const shared = await seedBoard({ admin, editors: [owner] });
    const own = await seedBoard({ admin: owner });
    const agent = await makeAgent(owner, { boardId: own.id });
    // Put on the shared board by its admin is not possible (only the owner adds
    // their agent), so the owner is made admin for a moment, as a real board would.
    await call(admin, 'boardAccessSet', { boardId: shared.id, people: { [owner.uid]: 'admin' } });
    await call(owner, 'boardAgentSet', { boardId: shared.id, agentId: agent.id, role: 'editor' });
    const { key } = await agentTokenFor(owner, agent.id);
    const t = await ticketOn(admin, shared);
    expect((await rest(key, 'GET', `/v1/tickets/${t}`)).status).toBe(200);

    // The person is removed; their agent is still in `access` — and reaches nothing.
    await call(admin, 'boardAccessSet', { boardId: shared.id, people: { [owner.uid]: null } });
    expect((await boardDoc(shared.id)).access[agent.id]).toBe('editor');
    expect((await rest(key, 'GET', `/v1/tickets/${t}`)).status).toBe(404);
    const boards = (await rest(key, 'GET', '/v1/boards')).body as { data: { key: string }[] };
    expect(boards.data.map((x) => x.key)).toEqual([own.key]);
  });
});

describe('§AA1 which board', () => {
  it('one board → implied; two → the call names one', async () => {
    const { owner } = await people('owner');
    const a = await seedBoard({ admin: owner });
    const b = await seedBoard({ admin: owner });
    const agent = await makeAgent(owner, { boardId: a.id });
    const { key } = await agentTokenFor(owner, agent.id);
    await ticketOn(owner, a, 'on A');
    await ticketOn(owner, b, 'on B');

    // Exactly one board: nothing to disambiguate.
    const one = await rest(key, 'GET', '/v1/tickets');
    expect(one.status).toBe(200);
    expect((one.body as { data: { title: string }[] }).data.map((t) => t.title)).toEqual(['on A']);
    expect((await rest(key, 'GET', '/v1/me')).body).toMatchObject({
      board: { key: a.key },
      role: 'editor',
    });

    // A second board: now it must say which — and is told which exist.
    await call(owner, 'boardAgentSet', { boardId: b.id, agentId: agent.id, role: 'viewer' });
    const two = await rest(key, 'GET', '/v1/tickets');
    expect(two.status).toBe(400);
    expect((two.body as { options: string[] }).options.sort()).toEqual([a.key, b.key].sort());
    expect((await rest(key, 'GET', '/v1/me')).body).toMatchObject({ board: null, role: null });

    const named = await rest(key, 'GET', `/v1/tickets?board=${b.key}`);
    expect((named.body as { data: { title: string }[] }).data.map((t) => t.title)).toEqual(['on B']);
    const inPath = await rest(key, 'GET', `/v1/boards/${a.key}/tickets`);
    expect((inPath.body as { data: { title: string }[] }).data.map((t) => t.title)).toEqual(['on A']);
  });

  it('a CONVERTED token falls back to its old board — only when none is named, only while on it', async () => {
    const { owner } = await people('owner');
    const old = await seedBoard({ admin: owner });
    const added = await seedBoard({ admin: owner });
    const agent = await makeAgent(owner, { boardId: old.id });
    await call(owner, 'boardAgentSet', { boardId: added.id, agentId: agent.id, role: 'editor' });
    const { key } = await convertedToken(owner, agent.id, old.id);
    await ticketOn(owner, old, 'on OLD');
    await ticketOn(owner, added, 'on ADDED');

    // What ran before the conversion named no board: it still lands on the old one.
    const dflt = await rest(key, 'GET', '/v1/tickets');
    expect(dflt.status).toBe(200);
    expect((dflt.body as { data: { title: string }[] }).data.map((t) => t.title)).toEqual(['on OLD']);
    expect((await rest(key, 'GET', '/v1/me')).body).toMatchObject({
      kind: 'agent',
      board: { key: old.key },
      default_board: { key: old.key },
    });
    // A named board always wins.
    const named = await rest(key, 'GET', `/v1/tickets?board=${added.key}`);
    expect((named.body as { data: { title: string }[] }).data.map((t) => t.title)).toEqual(['on ADDED']);
    // A new ticket with no board goes to the default too.
    const made = await rest(key, 'POST', '/v1/tickets', { title: 'from the old script' });
    expect(made.status).toBe(201);
    expect((made.body as { key: string }).key.startsWith(`${old.key}-`)).toBe(true);

    // A third board; then the agent leaves its old one: the default is not a way back in.
    const third = await seedBoard({ admin: owner });
    await call(owner, 'boardAgentSet', { boardId: third.id, agentId: agent.id, role: 'viewer' });
    await call(owner, 'boardAgentSet', { boardId: old.id, agentId: agent.id, role: null });
    const gone = await rest(key, 'GET', '/v1/tickets');
    expect(gone.status).toBe(400);
    expect((gone.body as { options: string[] }).options.sort()).toEqual([added.key, third.key].sort());
    expect((await rest(key, 'GET', '/v1/me')).body).toMatchObject({ board: null, default_board: null });
  });

  it('MCP: list_boards, and `board` is needed exactly when there are several', async () => {
    const { owner } = await people('owner');
    const a = await seedBoard({ admin: owner });
    const b = await seedBoard({ admin: owner });
    const agent = await makeAgent(owner, { boardId: a.id });
    await call(owner, 'boardAgentSet', { boardId: b.id, agentId: agent.id, role: 'viewer' });
    const { key } = await agentTokenFor(owner, agent.id);
    const mcp = await mcpClient(key);

    const names = (await mcp.listTools()).tools.map((t) => t.name);
    // Every board tool, the artifact tools and the §AA4 data tools — no checkbox list hid any.
    for (const n of ['list_boards', 'create_ticket', 'post_message', 'artifact_publish', 'artifact_data_batch'])
      expect(names).toContain(n);
    const who = JSON.parse(text(await mcp.callTool({ name: 'whoami', arguments: {} }))) as {
      kind: string;
      boards: { key: string }[];
    };
    expect(who.kind).toBe('agent');
    expect(who.boards.map((x) => x.key).sort()).toEqual([a.key, b.key].sort());

    const none = await mcp.callTool({ name: 'get_board', arguments: {} });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/needs a board/);
    const named = await mcp.callTool({ name: 'get_board', arguments: { board: b.key } });
    expect(named.isError).toBeFalsy();
    expect(JSON.parse(text(named))).toMatchObject({ key: b.key });
    await mcp.close();
  });
});

describe('§AA2 the role is the permission', () => {
  /** One agent, four boards, a different role on each — ONE token. */
  async function fourRoles() {
    const { owner, guest } = await people('owner', 'guest');
    const [viewing, commenting, editing, owning] = await Promise.all([
      seedBoard({ admin: owner }),
      seedBoard({ admin: owner }),
      seedBoard({ admin: owner }),
      seedBoard({ admin: owner }),
    ]);
    const agent = await makeAgent(owner);
    const set = (b: SeededBoard, role: 'admin' | 'editor' | 'commenter' | 'viewer') =>
      call(owner, 'boardAgentSet', { boardId: b.id, agentId: agent.id, role });
    await set(viewing, 'viewer');
    await set(commenting, 'commenter');
    await set(editing, 'editor');
    await set(owning, 'admin');
    const { key } = await agentTokenFor(owner, agent.id);
    return { owner, guest, agent, key, viewing, commenting, editing, owning };
  }
  const say = (key: string, ticket: string) =>
    rest(key, 'POST', `/v1/tickets/${ticket}/messages`, { body_markdown: 'On it.' });
  const retitle = (key: string, ticket: string) =>
    rest(key, 'PATCH', `/v1/tickets/${ticket}`, { title: 'Renamed by the agent' });
  /** The token's ctx, as the middleware builds it — for commands that have no REST route. */
  const asToken = { scopes: AGENT_TOKEN_SCOPES, boardIds: null } as const;

  it('viewer reads and cannot comment; commenter comments and cannot edit', async () => {
    const s = await fourRoles();
    const v = await ticketOn(s.owner, s.viewing);
    const c = await ticketOn(s.owner, s.commenting);

    expect((await rest(s.key, 'GET', `/v1/tickets/${v}`)).status).toBe(200);
    expect((await say(s.key, v)).status).toBe(403);
    expect((await retitle(s.key, v)).status).toBe(403);

    expect((await say(s.key, c)).status).toBe(201);
    expect((await retitle(s.key, c)).status).toBe(403);
    expect(
      (await rest(s.key, 'POST', `/v1/boards/${s.commenting.key}/tickets`, { title: 'x' })).status,
    ).toBe(403);
  });

  it('editor edits and creates, and cannot change settings, restore or touch webhooks', async () => {
    const s = await fourRoles();
    const e = await ticketOn(s.owner, s.editing);

    expect((await retitle(s.key, e)).status).toBe(200);
    expect(
      (await rest(s.key, 'POST', `/v1/boards/${s.editing.key}/tickets`, { title: 'new' })).status,
    ).toBe(201);
    // archive is an editor's; RESTORE is an admin's.
    expect((await rest(s.key, 'POST', `/v1/tickets/${e}/state`, { state: 'archived' })).status).toBe(200);
    expect((await rest(s.key, 'POST', `/v1/tickets/${e}/state`, { state: 'active' })).status).toBe(403);
    // Board settings (no REST route: the command, with the token's own ctx).
    await expect(
      asAgent(s.agent, 'boardUpdate', { boardId: s.editing.id, patch: { name: 'Mine now' } }, asToken),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await boardDoc(s.editing.id)).name).toBe(s.editing.board.name);
    // Webhooks: an editor does not even see that one exists.
    const hookId = uniq('wh');
    await db()
      .doc(paths.webhook(s.editing.id, hookId))
      .set({
        url: 'https://hooks.example.com/x',
        events: ['ticket.created'],
        secret: 'whsec_x',
        active: true,
        createdBy: s.owner.uid,
        createdAt: Date.now(),
        failures: 0,
      } as unknown as Webhook);
    expect((await rest(s.key, 'DELETE', `/v1/webhooks/${hookId}`)).status).toBe(404);
    expect((await db().doc(paths.webhook(s.editing.id, hookId)).get()).exists).toBe(true);
  });

  it('ADMIN (new for agents): board settings, stages, restore, webhooks', async () => {
    const s = await fourRoles();
    const t = await ticketOn(s.owner, s.owning);
    expect((await rest(s.key, 'GET', `/v1/boards/${s.owning.key}`)).status).toBe(200);

    // Restore — admin only.
    expect((await rest(s.key, 'POST', `/v1/tickets/${t}/state`, { state: 'archived' })).status).toBe(200);
    expect((await rest(s.key, 'POST', `/v1/tickets/${t}/state`, { state: 'active' })).status).toBe(200);
    // Board settings, with the token's own ctx.
    await asAgent(s.agent, 'boardUpdate', { boardId: s.owning.id, patch: { name: 'Run by the agent' } }, asToken);
    expect((await boardDoc(s.owning.id)).name).toBe('Run by the agent');
    // Webhooks.
    const hookId = uniq('wh');
    await db()
      .doc(paths.webhook(s.owning.id, hookId))
      .set({
        url: 'https://hooks.example.com/x',
        events: ['ticket.created'],
        secret: 'whsec_x',
        active: true,
        createdBy: s.owner.uid,
        createdAt: Date.now(),
        failures: 0,
      } as unknown as Webhook);
    const hooks = await rest(s.key, 'GET', `/v1/webhooks?board=${s.owning.key}`);
    expect((hooks.body as { data: { id: string }[] }).data.map((h) => h.id)).toContain(hookId);
    expect((await rest(s.key, 'DELETE', `/v1/webhooks/${hookId}`)).status).toBe(204);
    expect((await db().doc(paths.webhook(s.owning.id, hookId)).get()).exists).toBe(false);
    // …and being admin THERE gives nothing on the board where it only edits.
    await expect(
      asAgent(s.agent, 'boardUpdate', { boardId: s.editing.id, patch: { name: 'no' } }, asToken),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('an agent ADMIN still never manages people, agents, invites, boards or tokens', async () => {
    const s = await fourRoles();
    const helper = await makeAgent(s.owner, { name: 'Helper' });
    const before = await boardDoc(s.owning.id);

    // Through the doors: every one of these is refused.
    expect(
      (
        await rest(s.key, 'POST', `/v1/boards/${s.owning.key}/agents`, {
          agent: helper.id,
          role: 'editor',
        })
      ).status,
    ).toBe(403);
    expect((await rest(s.key, 'POST', '/v1/boards', { name: 'Mine', key: 'ZZAG' })).status).toBe(403);
    expect((await rest(s.key, 'POST', '/v1/agents', { name: 'Spawn' })).status).toBe(403);
    for (const cmd of ['apiKeyCreate', 'apiKeyRevoke', 'boardAccessSet', 'inviteCreate']) {
      const r = await rest(s.key, 'POST', `/api/${cmd}`, {
        name: 'stolen',
        kind: 'agent',
        actsAs: { kind: 'agent', id: s.agent.id },
      });
      expect([401, 403, 404]).toContain(r.status);
    }

    // And in the commands themselves, given the token's own ctx — so a door
    // that ever forgot the gate would still be refused:
    const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: 'forbidden' });
    // inviteCreate is reachable by SCOPE (board:admin) and by ROLE (admin): the handler says no.
    await refused(
      asAgent(
        s.agent,
        'inviteCreate',
        { boardId: s.owning.id, invites: [{ email: 'new@example.com', role: 'editor' }] },
        asToken,
      ),
    );
    await refused(
      asAgent(s.agent, 'boardAccessSet', { boardId: s.owning.id, people: { [s.owner.uid]: 'viewer' } }, asToken),
    );
    await refused(
      asAgent(s.agent, 'boardAgentSet', { boardId: s.owning.id, agentId: helper.id, role: 'editor' }, asToken),
    );
    await refused(asAgent(s.agent, 'boardCreate', { name: 'Mine', key: 'ZZAH' }, asToken));
    await refused(asAgent(s.agent, 'agentCreate', { name: 'Spawn', systemPrompt: '' }, asToken));
    await refused(
      asAgent(
        s.agent,
        'apiKeyCreate',
        { name: 'minted', kind: 'agent', actsAs: { kind: 'agent', id: s.agent.id } },
        asToken,
      ),
    );
    // Even with every scope there is — the handlers ask WHO, not what it carries.
    const everything = { scopes: undefined, boardIds: null } as never;
    await refused(
      asAgent(s.agent, 'boardAccessSet', { boardId: s.owning.id, people: { [s.owner.uid]: 'viewer' } }, everything),
    );
    await refused(
      asAgent(s.agent, 'boardAgentSet', { boardId: s.owning.id, agentId: helper.id, role: 'editor' }, everything),
    );

    const after = await boardDoc(s.owning.id);
    expect(after.access).toEqual(before.access);
    const keys = await db().collection(paths.apiKeys(s.owner.uid)).get();
    expect(keys.docs.filter((d) => ['stolen', 'minted'].includes((d.data() as ApiKey).name))).toHaveLength(0);
  });

  it('an agent admin is not the board\'s "last admin": a person must remain one', async () => {
    const { owner, second } = await people('owner', 'second');
    const board = await seedBoard({ admin: owner, editors: [second] });
    await makeAgent(owner, { boardId: board.id, role: 'admin' });

    // The only PERSON who is admin cannot step down or leave: the agent does not count.
    await expect(
      call(owner, 'boardAccessSet', { boardId: board.id, people: { [owner.uid]: 'editor' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      call(owner, 'boardAccessSet', { boardId: board.id, leave: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a commenter agent still moves only inside its stage grant', async () => {
    const { owner } = await people('owner');
    const board = await seedBoard({ admin: owner });
    const agent = await makeAgent(owner);
    await call(owner, 'boardAgentSet', {
      boardId: board.id,
      agentId: agent.id,
      role: 'commenter',
      // Not Done: the seeded Done stage needs a field first (422), which is not what this tests.
      stageGrant: { stages: [STAGES.doing, STAGES.review] },
    });
    const { key } = await agentTokenFor(owner, agent.id);
    const inReview = await call(owner, 'ticketCreate', {
      boardId: board.id,
      title: 'review me',
      stageId: STAGES.doing,
    });
    const inTodo = await call(owner, 'ticketCreate', { boardId: board.id, title: 'not yet' });

    const moved = await rest(key, 'POST', `/v1/tickets/${inReview.key}/move`, { stage: 'Review' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await rest(key, 'POST', `/v1/tickets/${inTodo.key}/move`, { stage: 'Review' })).status).toBe(403);
  });
});

describe('§AA6 a token from before §AA still works, unconverted', () => {
  it('a board token acting as an agent: one board, its own scopes, exactly as before', async () => {
    const { owner } = await people('owner');
    const a = await seedBoard({ admin: owner });
    const b = await seedBoard({ admin: owner });
    const agent = await makeAgent(owner, { boardId: a.id });
    await call(owner, 'boardAgentSet', { boardId: b.id, agentId: agent.id, role: 'editor' });
    const legacy = await agentKeyFor(
      owner,
      agent.id,
      ['board:read', 'tickets:read', 'comments:read'],
      a.id,
    );
    const onA = await ticketOn(owner, a);
    const onB = await ticketOn(owner, b);

    expect(await keyRow(owner, legacy.keyId)).toMatchObject({ kind: 'board', boardId: a.id });
    const me = await rest(legacy.key, 'GET', '/v1/me');
    expect(me.body).toMatchObject({ kind: 'board', board: { key: a.key }, token: { kind: 'board' } });
    // Its one board, no parameter needed — although the agent is on two.
    expect((await rest(legacy.key, 'GET', '/v1/tickets')).status).toBe(200);
    expect((await rest(legacy.key, 'GET', `/v1/tickets/${onA}`)).status).toBe(200);
    expect((await rest(legacy.key, 'GET', `/v1/tickets/${onB}`)).status).toBe(404);
    // Its checkbox list still narrows: the agent is an editor, the token reads only.
    expect(
      (await rest(legacy.key, 'POST', `/v1/tickets/${onA}/messages`, { body_markdown: 'x' })).status,
    ).toBe(403);
    // Leaving ITS board still revokes it (agentRemoved) — it was a token for that board.
    await call(owner, 'boardAgentSet', { boardId: a.id, agentId: agent.id, role: null });
    expect(await keyRow(owner, legacy.keyId)).toMatchObject({ revokedReason: 'agentRemoved' });
    expect((await rest(legacy.key, 'GET', '/v1/me')).status).toBe(401);
  });

  it('a board token acting as an agent still cannot be given admin scopes', async () => {
    const { owner } = await people('owner');
    const a = await seedBoard({ admin: owner });
    const agent: TestAgent = await makeAgent(owner, { boardId: a.id, role: 'admin' });
    await expect(
      agentKeyFor(owner, agent.id, ['board:read', 'board:admin'], a.id),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

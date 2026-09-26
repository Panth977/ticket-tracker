/**
 * PHASE 17 (docs/plan/agents.html §Y, §Z2, §W) under the emulators:
 *
 *   §Y   a message with a turn receipt moves THREE counters in the same
 *        write — the ticket's cost, the board's cost and the day row — and a
 *        replayed post moves none of them twice.
 *   §Z2  POST /v1/agents, POST /v1/boards, POST /v1/boards/{KEY}/agents work
 *        with an ACCOUNT token and are refused for a BOARD token.
 *   §W   GET /v1/live mints a credential whose uid and `board` claim are what
 *        backend/database.rules.json expects, and the RTDB emulator honours
 *        it: the token's own nodes answer, anybody else's are refused.
 */
import { describe, expect, it } from 'vitest';
import {
  costDayOf,
  paths,
  SCOPE_PRESETS,
  type Board,
  type BoardDayStats,
  type Scope,
  type Ticket,
  type User,
} from '@tm/shared';
import { syncReaders } from '../../src/commands/boardShared.js';
import { db, rtdbAdmin } from '../../src/runtime/firebase.js';
import { call, setupEmulators } from '../harness/index.js';
import { people, seedBoard } from '../tickets/helpers.js';
import { msgsOf } from '../tickets/store.js';
import { agentKeyFor, apiKeyFor, rest, seedAgent } from './helpers.js';

setupEmulators();

/** An ACCOUNT token (§R1): no board, acts as the person, account scopes allowed. */
const accountKeyFor = (user: Parameters<typeof apiKeyFor>[0], scopes: Scope[], name = 'claude') =>
  call(user, 'apiKeyCreate', { name, kind: 'account' as const, scopes });

const receipt = (n: number, costUsd: number) => ({
  n,
  outcome: 'review' as const,
  cost_usd: costUsd,
  session_usd: 21.1,
  duration_ms: 743_000,
  api_turns: 46,
  model: 'claude-fable-5-1',
  usage: { input: 1000, output: 200, cache_read: 5000, cache_write: 100 },
});

/** The payload of a JWT, without verifying it (the emulator's tokens are unsigned anyway). */
const jwtPayload = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;

describe('§Y — the turn receipt moves the ticket, the board and the day', () => {
  it('stores run on the message and increments three counters in one write; a replay counts once', async () => {
    const { owner } = await people('owner');
    const b = await seedBoard({ admin: owner });
    const { id: agentId } = await seedAgent(owner, { boardId: b.id, role: 'editor' });
    const { key } = await agentKeyFor(owner, agentId, [...SCOPE_PRESETS.worker] as Scope[], b.id);
    const { key: ownerKey } = await apiKeyFor(owner, [...SCOPE_PRESETS.everything], b.id);
    const t = (await rest(ownerKey, 'POST', '/v1/tickets', { title: 'Costly' })).body as {
      key: string;
      id: string;
      cost: unknown;
    };
    expect(t.cost).toBe(null);

    const r1 = await rest(
      key,
      'POST',
      `/v1/tickets/${t.key}/messages`,
      { body_markdown: 'Turn 1 · review · $1.24 · 12 min', run: receipt(1, 1.24) },
      { 'Idempotency-Key': 'turn-1' },
    );
    expect(r1.status).toBe(201);
    const m1 = r1.body as { id: string; kind: string; run: { n: number; cost_usd: number } };
    expect(m1.kind).toBe('comment');
    expect(m1.run).toEqual(receipt(1, 1.24));

    // The same turn again (a retried post): ONE message, ONE receipt counted.
    const again = await rest(
      key,
      'POST',
      `/v1/tickets/${t.key}/messages`,
      { body_markdown: 'Turn 1 · review · $1.24 · 12 min', run: receipt(1, 1.24) },
      { 'Idempotency-Key': 'turn-1' },
    );
    expect((again.body as { id: string }).id).toBe(m1.id);

    const r2 = await rest(key, 'POST', `/v1/tickets/${t.key}/messages`, {
      body_markdown: 'Turn 2 · waiting · $0.10 · 1 min',
      run: { ...receipt(2, 0.1), outcome: 'waiting', usage: null, model: null },
    });
    expect(r2.status).toBe(201);
    // A plain comment moves nothing.
    await rest(key, 'POST', `/v1/tickets/${t.key}/messages`, { body_markdown: 'Just a note' });

    const ticket = (await db().doc(paths.ticket(b.id, t.id)).get()).data() as Ticket;
    expect(ticket.cost).toEqual({ usd: 1.34, runs: 2 });
    const board = (await db().doc(paths.board(b.id)).get()).data() as Board;
    expect(board.cost).toEqual({ usd: 1.34, runs: 2 });
    const days = await db().collection(paths.stats(b.id)).get();
    expect(days.size).toBe(1);
    const day = days.docs[0]!.data() as BoardDayStats;
    expect(days.docs[0]!.id).toBe(day.day);
    expect(day.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(day.day).toBe(costDayOf(day.updatedAt));
    expect(day).toMatchObject({
      costUsd: 1.34,
      runs: 2,
      tickets: { [t.key]: { usd: 1.34, runs: 2 } },
    });

    // The stored message carries the camelCase receipt; the public one the wire shape.
    const stored = (await msgsOf(b.id, t.id)).filter((m) => m.kind === 'comment');
    expect(stored).toHaveLength(3);
    expect(stored[0]!.run).toMatchObject({ n: 1, costUsd: 1.24, usage: { cacheRead: 5000 } });
    expect(stored[2]!.run ?? null).toBe(null);
    const pub = (await rest(key, 'GET', `/v1/tickets/${t.key}?messages=10`)).body as {
      cost: { usd: number; runs: number };
      messages: { run: unknown }[];
    };
    expect(pub.cost).toEqual({ usd: 1.34, runs: 2 });
    expect(pub.messages.map((m) => (m.run ? (m.run as { n: number }).n : null))).toEqual([
      1,
      2,
      null,
    ]);
    const boardPub = (await rest(key, 'GET', '/v1/board')).body as { cost: unknown };
    expect(boardPub.cost).toEqual({ usd: 1.34, runs: 2 });
  });

  it('a malformed receipt is a 400, and a receipt from the app door is accepted too', async () => {
    const { owner } = await people('owner');
    const b = await seedBoard({ admin: owner });
    const { key } = await apiKeyFor(owner, [...SCOPE_PRESETS.everything], b.id);
    const t = (await rest(key, 'POST', '/v1/tickets', { title: 'x' })).body as {
      key: string;
      id: string;
    };
    const bad = await rest(key, 'POST', `/v1/tickets/${t.key}/messages`, {
      body_markdown: 'x',
      run: { ...receipt(1, 1), outcome: 'won' },
    });
    expect(bad.status).toBe(400);
    const { messageId } = await call(owner, 'messagePost', {
      boardId: b.id,
      ticketId: t.id,
      clientId: 'app-turn-1',
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Turn 1' }] }],
      },
      run: {
        n: 1,
        outcome: 'stopped',
        costUsd: 0.5,
        sessionUsd: null,
        durationMs: 10,
        apiTurns: null,
        model: null,
        usage: null,
      },
    });
    expect(messageId).toBe('app-turn-1');
    const ticket = (await db().doc(paths.ticket(b.id, t.id)).get()).data() as Ticket;
    expect(ticket.cost).toEqual({ usd: 0.5, runs: 1 });
  });
});

describe('§Z2 — the account-token routes', () => {
  it('creates an agent, a kanban board and puts the agent on it as an editor', async () => {
    const { owner } = await people('owner');
    const { key } = await accountKeyFor(owner, [...SCOPE_PRESETS.fullAccount] as Scope[]);

    const a = await rest(key, 'POST', '/v1/agents', {
      name: 'Builder',
      description: 'Builds things',
      system_prompt: '# You build',
      icon: 'claude',
    });
    expect(a.status).toBe(201);
    const agent = a.body as {
      id: string;
      kind: string;
      name: string;
      description: string;
      system_prompt: string;
      archived: boolean;
      created_at: string;
    };
    expect(agent).toMatchObject({
      kind: 'agent',
      name: 'Builder',
      description: 'Builds things',
      system_prompt: '# You build',
      icon: 'claude',
      archived: false,
    });
    expect(agent.id).toMatch(/^ag_/);

    const boardKey = `W${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const created = await rest(
      key,
      'POST',
      '/v1/boards',
      { name: 'Workspace', key: boardKey, template: 'kanban' },
      { 'Idempotency-Key': 'board-1' },
    );
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe(`/v1/boards/${boardKey}`);
    const board = created.body as {
      id: string;
      key: string;
      stages: { name: string }[];
      members: { id: string; role: string }[];
      cost: unknown;
    };
    expect(board.key).toBe(boardKey);
    // The stages the runtime needs (§Z2), whatever else the template seeds around them.
    expect(board.stages.map((s) => s.name)).toEqual(
      expect.arrayContaining(['To do', 'In progress', 'Review', 'Done']),
    );
    expect(board.members).toEqual([expect.objectContaining({ id: owner.uid, role: 'admin' })]);
    expect(board.cost).toBe(null);
    // A taken key is a 409 (a retry with the same Idempotency-Key is the same board).
    const retry = await rest(
      key,
      'POST',
      '/v1/boards',
      { name: 'Workspace', key: boardKey, template: 'kanban' },
      { 'Idempotency-Key': 'board-1' },
    );
    expect(retry.status).toBe(201);
    expect((retry.body as { id: string }).id).toBe(board.id);
    const taken = await rest(key, 'POST', '/v1/boards', { name: 'Again', key: boardKey });
    expect(taken.status).toBe(409);

    const put = await rest(key, 'POST', `/v1/boards/${boardKey}/agents`, {
      agent: agent.id,
      role: 'editor',
    });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true });
    const withAgent = (await rest(key, 'GET', `/v1/boards/${boardKey}`)).body as {
      members: { id: string; role: string; kind: string }[];
    };
    expect(withAgent.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: agent.id, role: 'editor', kind: 'agent' }),
      ]),
    );
    // Change to a commenter with a grant, then remove.
    const stage = (await rest(key, 'GET', `/v1/boards/${boardKey}`)).body as {
      stages: { id: string }[];
    };
    const grant = await rest(key, 'POST', `/v1/boards/${boardKey}/agents`, {
      agent: agent.id,
      role: 'commenter',
      stage_grant: { stages: [stage.stages[1]!.id], assigned_only: true },
    });
    expect(grant.status).toBe(200);
    const stored = (await db().doc(paths.board(board.id)).get()).data() as Board;
    expect(stored.access[agent.id]).toBe('commenter');
    expect(stored.stageGrants[agent.id]).toEqual({
      stages: [stage.stages[1]!.id],
      assignedOnly: true,
    });
    const removed = await rest(key, 'POST', `/v1/boards/${boardKey}/agents`, {
      agent: agent.id,
      role: null,
    });
    expect(removed.status).toBe(200);
    const after = (await db().doc(paths.board(board.id)).get()).data() as Board;
    expect(after.access[agent.id]).toBeUndefined();
    // Somebody else's agent: not found (agents are private).
    const { priya } = await people('priya');
    const { id: theirs } = await seedAgent(priya);
    const nope = await rest(key, 'POST', `/v1/boards/${boardKey}/agents`, {
      agent: theirs,
      role: 'editor',
    });
    expect(nope.status).toBe(404);
  });

  it('a BOARD token is refused on all three (403), whatever its scopes', async () => {
    const { owner } = await people('owner');
    const b = await seedBoard({ admin: owner });
    const { key } = await apiKeyFor(owner, [...SCOPE_PRESETS.everything], b.id);
    expect((await rest(key, 'POST', '/v1/boards', { name: 'x', key: 'ZZZZ' })).status).toBe(403);
    expect((await rest(key, 'POST', '/v1/agents', { name: 'x' })).status).toBe(403);
    expect(
      (
        await rest(key, 'POST', `/v1/boards/${b.key}/agents`, {
          agent: 'ag_Bu1lder000000001',
          role: 'editor',
        })
      ).status,
    ).toBe(403);
    // An account token WITHOUT the scope is refused the same way.
    const { key: narrow } = await accountKeyFor(owner, ['tickets:read'] as Scope[]);
    expect((await rest(narrow, 'POST', '/v1/boards', { name: 'x', key: 'ZZZZ' })).status).toBe(403);
    // And the app door still works for the person (nothing was taken away).
    const { agentId } = await call(owner, 'agentCreate', { name: 'Via app' });
    expect(agentId).toMatch(/^ag_/);
  });
});

describe('§W — GET /v1/live', () => {
  it('an agent token gets its wake node and its board, with the uid and board claim the rules read', async () => {
    const { owner } = await people('owner');
    const b = await seedBoard({ admin: owner });
    const other = await seedBoard({ admin: owner });
    const { id: agentId } = await seedAgent(owner, { boardId: b.id, role: 'editor' });
    const { key } = await agentKeyFor(owner, agentId, [...SCOPE_PRESETS.worker] as Scope[], b.id);

    const r = await rest(key, 'GET', '/v1/live');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const cred = r.body as {
      database_url: string;
      auth: string;
      expires_in: number;
      paths: string[];
    };
    expect(cred.paths).toEqual([`agents/${agentId}/wake`, `rev/${b.id}`]);
    expect(cred.expires_in).toBeGreaterThan(0);
    expect(cred.database_url).toMatch(/^https?:\/\//);
    const claims = jwtPayload(cred.auth);
    expect(claims.user_id ?? claims.sub).toBe(agentId);
    expect(claims.board).toBe(b.id);

    // The agent never became a person: no users/ profile, no allow-list verdict.
    expect((await db().doc(paths.user(agentId)).get()).exists).toBe(false);

    // The RTDB emulator honours it: its own nodes answer, anybody else's are refused.
    const url = new URL(cred.database_url);
    const ns = url.searchParams.get('ns');
    const read = async (path: string) => {
      const q = new URLSearchParams({ ...(ns ? { ns } : {}), auth: cred.auth });
      const res = await fetch(`${url.origin}/${path}.json?${q}`);
      return res.status;
    };
    await rtdbAdmin().ref(`rev/${b.id}`).set({ at: Date.now() });
    await rtdbAdmin().ref(`rev/${other.id}`).set({ at: Date.now() });
    await rtdbAdmin().ref(`agents/${agentId}/wake`).set({ at: Date.now() });
    expect(await read(`rev/${b.id}`)).toBe(200);
    expect(await read(`agents/${agentId}/wake`)).toBe(200);
    expect(await read(`rev/${other.id}`)).toBe(401);
    expect(await read(`agents/ag_SomebodyElse0001/wake`)).toBe(401);
    expect(await read(`boardReaders/${b.id}`)).toBe(401);
  });

  it('a person: a board token gets its board; an account token every board it reaches now', async () => {
    const { owner } = await people('owner');
    const eng = await seedBoard({ admin: owner });
    const ops = await seedBoard({ admin: owner });
    await syncReaders(eng.id, [owner.uid]);
    await syncReaders(ops.id, [owner.uid]);

    const { key: boardKey } = await apiKeyFor(owner, ['events:read'], eng.id);
    const one = (await rest(boardKey, 'GET', '/v1/live')).body as { auth: string; paths: string[] };
    expect(one.paths).toEqual([`rev/${eng.id}`]);
    expect(jwtPayload(one.auth).board).toBe(eng.id);

    const { key: accountKey } = await accountKeyFor(owner, ['events:read'] as Scope[]);
    const all = (await rest(accountKey, 'GET', '/v1/live')).body as {
      auth: string;
      database_url: string;
      paths: string[];
    };
    expect([...all.paths].sort()).toEqual([`rev/${eng.id}`, `rev/${ops.id}`].sort());
    const claims = jwtPayload(all.auth);
    expect(claims.user_id ?? claims.sub).toBe(owner.uid);
    expect(claims.board).toBeUndefined();
    // A person still has their profile, untouched by the sign-in.
    expect(((await db().doc(paths.user(owner.uid)).get()).data() as User).deletedAt).toBe(null);

    // Read through the boardReaders mirror (no claim needed).
    const url = new URL(all.database_url);
    const ns = url.searchParams.get('ns');
    await rtdbAdmin().ref(`rev/${ops.id}`).set({ at: Date.now() });
    const q = new URLSearchParams({ ...(ns ? { ns } : {}), auth: all.auth });
    expect((await fetch(`${url.origin}/rev/${ops.id}.json?${q}`)).status).toBe(200);

    // Without the scope: 403.
    const { key: noScope } = await apiKeyFor(owner, ['tickets:read'], eng.id);
    expect((await rest(noScope, 'GET', '/v1/live')).status).toBe(403);
  });
});

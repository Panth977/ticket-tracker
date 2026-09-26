/**
 * Board tokens (API key v2) acting as a PERSON + REST /v1: the 'Scripting
 * with the REST API' flow end to end through the real hono app. Agent tokens
 * are in agent-api.emu.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { paths, SCOPE_PRESETS, type ApiKey, type Ticket } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { call, createUser, setupEmulators } from '../harness/index.js';
import { people, seedBoard, STAGES } from '../tickets/helpers.js';
import { msgsOf } from '../tickets/store.js';
import { apiKeyFor, rest } from './helpers.js';

setupEmulators();

describe('apiKeyCreate / apiKeyRevoke', () => {
  it('returns the key once, stores only its hash, and a revoked key answers 401', async () => {
    const u = await createUser({ name: 'Panth' });
    const b = await seedBoard({ admin: u });
    const { key, keyId, prefix } = await apiKeyFor(u, ['tickets:read'], b.id);
    expect(key).toMatch(/^tm_live_[0-9A-Za-z]{32}$/);
    const row = (await db().doc(paths.apiKey(u.uid, keyId)).get()).data() as ApiKey;
    expect(row.hash).not.toContain(key);
    expect(JSON.stringify(row)).not.toContain(key);
    expect(row.prefix).toBe(key.slice(0, 12));
    expect(prefix).toBe(row.prefix);
    expect(row).toMatchObject({
      boardId: b.id,
      actsAs: { kind: 'user', id: u.uid },
      scopes: ['tickets:read'],
      revokedAt: null,
    });

    expect((await rest(key, 'GET', '/v1/me')).status).toBe(200);
    await call(u, 'apiKeyRevoke', { keyId });
    expect((await db().doc(paths.apiKey(u.uid, keyId)).get()).get('revokedReason')).toBe('owner');
    const r = await rest(key, 'GET', '/v1/me');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(
      /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/v1"/,
    );
  });

  it('refuses boards the person is not on (404, like a board that does not exist); admin scopes need an admin', async () => {
    const { a, b } = await people('a', 'b');
    const other = await seedBoard({ admin: b, editors: [a] });
    const mine = await seedBoard({ admin: a });
    const stranger = await seedBoard({ admin: b });
    await expect(
      call(a, 'apiKeyCreate', { name: 'x', scopes: ['tickets:read'], boardId: stranger.id }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      call(a, 'apiKeyCreate', { name: 'x', scopes: ['tickets:read'], boardId: 'nope' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      call(a, 'apiKeyCreate', { name: 'x', scopes: ['webhooks:manage'], boardId: other.id }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(a, 'apiKeyCreate', { name: 'x', scopes: ['webhooks:manage'], boardId: mine.id }),
    ).resolves.toMatchObject({ key: expect.any(String) });
  });

  it('expires after expiresInDays; a person who leaves the board loses the token', async () => {
    const { a, b } = await people('a', 'b');
    const board = await seedBoard({ admin: b, editors: [a] });
    const { key, keyId } = await call(a, 'apiKeyCreate', {
      name: 'x',
      scopes: ['board:read'],
      boardId: board.id,
      expiresInDays: 30,
    });
    const row = (await db().doc(paths.apiKey(a.uid, keyId)).get()).data() as ApiKey;
    expect(row.expiresAt! - row.createdAt).toBe(30 * 86_400_000);
    expect((await rest(key, 'GET', '/v1/me')).status).toBe(200);
    await db()
      .doc(paths.board(board.id))
      .update({ [`access.${a.uid}`]: FieldValue.delete() });
    const gone = await rest(key, 'GET', '/v1/me');
    expect(gone.status).toBe(401);
    expect((gone.body as { detail: string }).detail).toMatch(/no longer on its board/);
    await db()
      .doc(paths.apiKey(a.uid, keyId))
      .update({ expiresAt: Date.now() - 1 });
    expect((await rest(key, 'GET', '/v1/me')).status).toBe(401);
  });

  it('rate limits per key with 429 + Retry-After — when limits are switched on (§X: off by default)', async () => {
    process.env.TM_RATE_LIMITS = '1';
    const u = await createUser();
    const b = await seedBoard({ admin: u });
    const { key, keyId } = await apiKeyFor(u, ['board:read'], b.id);
    await db()
      .doc(paths.apiKey(u.uid, keyId))
      .update({ limits: { perMin: 2, perDay: 100 } });
    expect((await rest(key, 'GET', '/v1/me')).status).toBe(200);
    expect((await rest(key, 'GET', '/v1/me')).status).toBe(200);
    const r = await rest(key, 'GET', '/v1/me');
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(r.headers.get('content-type')).toContain('application/problem+json');
    delete process.env.TM_RATE_LIMITS;
  });
});

describe('REST /v1', () => {
  it('401 with WWW-Authenticate when there is no token; openapi.json is public', async () => {
    const r = await rest(null, 'GET', '/v1/board');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata=');
    const o = await rest(null, 'GET', '/v1/openapi.json');
    expect(o.status).toBe(200);
    const doc = o.body as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/me',
        '/v1/board',
        '/v1/tickets',
        '/v1/tickets/{KEY}/files',
        '/v1/events/stream',
        '/v1/webhooks/{id}',
        '/v1/intake',
      ]),
    );
    expect(doc.components.schemas.Ticket).toBeTruthy();
  });

  it('create with Idempotency-Key, names not ids, read back, patch, move, comment', async () => {
    const { admin, priya } = await people('admin', 'priya');
    const b = await seedBoard({ admin, editors: [priya] });
    const { key } = await apiKeyFor(admin, [...SCOPE_PRESETS.everything], b.id, 'Zendesk sync');

    const me = await rest(key, 'GET', '/v1/me');
    expect(me.body).toMatchObject({
      principal: { kind: 'user', id: admin.uid, email: admin.email },
      owner: null,
      board: { id: b.id, key: b.key },
      role: 'admin',
      via: 'api',
      token: { name: 'Zendesk sync' },
    });
    const boards = await rest(key, 'GET', '/v1/boards');
    expect((boards.body as { data: { key: string }[] }).data.map((x) => x.key)).toEqual([b.key]);
    const one = await rest(key, 'GET', `/v1/board`);
    expect(one.status).toBe(200);
    expect(
      (one.body as { members: { email: string; kind: string }[] }).members
        .map((m) => m.email)
        .sort(),
    ).toEqual([admin.email, priya.email].sort());
    expect((await rest(key, 'GET', `/v1/board?board=${b.key.toLowerCase()}`)).status).toBe(200);

    const body = {
      title: 'Login redirect loops',
      description_md: `Ping @${priya.email} please`,
      stage: 'doing',
      priority: 'High',
      tags: ['bug'],
      assignees: [priya.email],
      due_at: '2030-01-02T10:00:00Z',
      fields: { Client: 'Acme', Points: 3 },
    };
    const created = await rest(key, 'POST', `/v1/tickets`, body, { 'Idempotency-Key': 'req-1' });
    expect(created.status).toBe(201);
    const t = created.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(t.key).toBe(`${b.key}-1`);
    expect(t.stage).toMatchObject({ name: 'Doing', category: 'active' });
    expect(t.priority).toMatchObject({ name: 'High' });
    expect(t.tags).toEqual(['bug']);
    expect(t.assignees[0].email).toBe(priya.email);
    expect(t.fields).toEqual({ Client: 'Acme', Points: 3 });
    expect(t.description_md).toContain(`[@${priya.displayName}](mailto:${priya.email})`);
    expect(t.due_at).toBe('2030-01-02T10:00:00.000Z');

    // The retry is ONE ticket.
    const again = await rest(key, 'POST', `/v1/tickets`, body, { 'Idempotency-Key': 'req-1' });
    expect(again.status).toBe(201);
    expect((again.body as { key: string }).key).toBe(t.key);
    const all = await db().collection(paths.tickets(b.id)).get();
    expect(all.size).toBe(1);
    const stored = all.docs[0]!.data() as Ticket;
    expect(stored.createdVia).toBe('api');

    // Unknown names say which exist.
    const bad = await rest(key, 'POST', `/v1/tickets`, { title: 'x', stage: 'Nope' });
    expect(bad.status).toBe(400);
    expect((bad.body as { detail: string }).detail).toContain('To do, Doing, Review, Done');

    const got = await rest(key, 'GET', `/v1/tickets/${t.key}`);
    expect(got.body).toMatchObject({
      title: body.title,
      watchers: expect.any(Array),
      pinned_messages: [],
      files: [],
    });

    const patched = await rest(key, 'PATCH', `/v1/tickets/${t.key}`, {
      title: 'Login loop',
      fields: { Points: 5 },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      title: 'Login loop',
      fields: { Client: 'Acme', Points: 5 },
    });

    const moved = await rest(key, 'POST', `/v1/tickets/${t.key}/move`, { stage: 'Review' });
    expect((moved.body as { stage: { id: string } }).stage.id).toBe(STAGES.review);

    const c1 = await rest(
      key,
      'POST',
      `/v1/tickets/${t.key}/messages`,
      { body_markdown: `Looking at it, see #${t.key}` },
      { 'Idempotency-Key': 'c-1' },
    );
    expect(c1.status).toBe(201);
    const c1b = c1.body as { id: string; via: string; body_md: string; author: { kind: string } };
    expect(c1b.via).toBe('api');
    expect(c1b.author.kind).toBe('user');
    const again2 = await rest(
      key,
      'POST',
      `/v1/tickets/${t.key}/messages`,
      { body_markdown: `Looking at it, see #${t.key}` },
      { 'Idempotency-Key': 'c-1' },
    );
    expect((again2.body as { id: string }).id).toBe(c1b.id);

    const comments = (await msgsOf(b.id, all.docs[0]!.id)).filter((m) => m.kind === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0]!.via).toBe('api');

    const list = await rest(key, 'GET', `/v1/tickets/${t.key}/messages?limit=1`);
    const page = list.body as { data: unknown[]; next_cursor: string | null };
    expect(page.data).toHaveLength(1);

    const state = await rest(key, 'POST', `/v1/tickets/${t.key}/assignees`, {
      add: ['me'],
      remove: [priya.email],
    });
    expect((state.body as { assignees: { id: string }[] }).assignees.map((a) => a.id)).toEqual([
      admin.uid,
    ]);
    await rest(key, 'POST', `/v1/tickets/${t.key}/assignees`, {
      add: [priya.email],
      remove: ['me'],
    });

    const listed = await rest(
      key,
      'GET',
      `/v1/tickets?stage=Review&assignee=${encodeURIComponent(priya.email)}`,
    );
    expect((listed.body as { data: { key: string }[] }).data.map((x) => x.key)).toEqual([t.key]);
    const none = await rest(key, 'GET', `/v1/tickets?stage=Doing`);
    expect((none.body as { data: unknown[] }).data).toEqual([]);

    const found = await rest(key, 'GET', `/v1/search?q=${encodeURIComponent('login')}`);
    expect((found.body as { data: { key: string }[] }).data.map((x) => x.key)).toEqual([t.key]);
  });

  it('scopes and board narrowing: 403 for a missing scope, 404 for a board outside the key', async () => {
    const { admin } = await people('admin');
    const b1 = await seedBoard({ admin });
    const b2 = await seedBoard({ admin });
    const { key } = await apiKeyFor(admin, ['tickets:read'], b1.id);
    const w = await rest(key, 'POST', `/v1/tickets`, { title: 'x' });
    expect(w.status).toBe(403);
    const other = await rest(key, 'GET', `/v1/tickets?board=${b2.key}`);
    expect(other.status).toBe(404);
    const hooks = await rest(key, 'GET', '/v1/webhooks');
    expect(hooks.status).toBe(403);
    // The ticket of another board, by key: not found.
    const { key: k2 } = await apiKeyFor(admin, ['tickets:create'], b2.id);
    const t2 = await rest(k2, 'POST', '/v1/tickets', { title: 'elsewhere' });
    expect(t2.status).toBe(201);
    expect((await rest(key, 'GET', `/v1/tickets/${(t2.body as { key: string }).key}`)).status).toBe(
      404,
    );
  });

  it('a viewer cannot write, whatever scopes their key has', async () => {
    const { admin, viewer } = await people('admin', 'viewer');
    const b = await seedBoard({ admin, viewers: [viewer] });
    const { key } = await apiKeyFor(viewer, [...SCOPE_PRESETS.everything], b.id);
    const r = await rest(key, 'POST', `/v1/tickets`, { title: 'x' });
    expect(r.status).toBe(403);
  });
});

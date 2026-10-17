/**
 * Dictionaries (docs/plan/dictionary.html): who may read and write which,
 * grants to boards, artifacts and agents as a ceiling, GET /v1/env (what an
 * orchestrator hands its agents), the REST door and the env migration.
 */
import { describe, expect, it } from 'vitest';
import { paths } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { envDictionaryId, migrateEnvToDictionaries } from '../../src/migrate/dictionary.js';
import { call, setupEmulators } from '../harness/index.js';
import { people, seedBoard } from '../tickets/helpers.js';
import { agentTokenFor, rest, seedAgent } from '../platform/helpers.js';

setupEmulators();

describe('dictionaries', () => {
  it('create with entries; owner writes, editor writes, viewer reads, outsider gets 404', async () => {
    const { asha, ed, vi, out } = await people('asha', 'ed', 'vi', 'out');
    const { dictionaryId } = await call(asha, 'dictionaryCreate', {
      name: 'Deploy',
      entries: [
        { key: 'API_URL', value: 'https://x.test' },
        { key: 'limits', value: { daily: 5, tiers: [[1, 2], [3]] } },
      ],
    });
    await call(asha, 'dictionaryShare', { dictionaryId, email: ed.email!, role: 'editor' });
    await call(asha, 'dictionaryShare', { dictionaryId, email: vi.email!, role: 'viewer' });

    const got = await call(vi, 'dictionaryGet', { dictionaryId });
    expect(got.dictionary).toMatchObject({ name: 'Deploy', reach: 'read', stats: { entries: 2 } });
    expect(got.entries).toEqual([
      { key: 'API_URL', value: 'https://x.test' },
      { key: 'limits', value: { daily: 5, tiers: [[1, 2], [3]] } },
    ]);

    const set = await call(ed, 'dictionarySet', {
      dictionaryId,
      set: { API_URL: null, N: 3, API_URL2: 'b' },
    });
    expect(set.entries.map((e) => e.key)).toEqual(['limits', 'N', 'API_URL2']);
    await expect(call(vi, 'dictionarySet', { dictionaryId, set: { X: 1 } })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(call(out, 'dictionaryGet', { dictionaryId })).rejects.toMatchObject({
      code: 'not_found',
    });
    // Only the owner manages it.
    await expect(
      call(ed, 'dictionaryUpdate', { dictionaryId, name: 'Mine' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // A stale write is refused.
    await expect(
      call(asha, 'dictionarySet', { dictionaryId, replace: [], expectedUpdatedAt: 1 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const r = await call(asha, 'dictionarySet', {
      dictionaryId,
      replace: [{ key: 'ONLY', value: true }],
      expectedUpdatedAt: set.entriesUpdatedAt,
    });
    expect(r.entries).toEqual([{ key: 'ONLY', value: true }]);

    // Bad keys and duplicates are refused.
    await expect(
      call(asha, 'dictionarySet', { dictionaryId, set: { '.bad': 1 } } as never),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      call(asha, 'dictionarySet', {
        dictionaryId,
        replace: [
          { key: 'a', value: 1 },
          { key: 'a', value: 2 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid' });

    // Archived: read-only until restored.
    await call(asha, 'dictionaryUpdate', { dictionaryId, archived: true });
    await expect(
      call(asha, 'dictionarySet', { dictionaryId, set: { X: 1 } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await call(asha, 'dictionaryUpdate', { dictionaryId, archived: false });

    await call(asha, 'dictionaryDelete', { dictionaryId });
    expect((await db().doc(paths.dictionary(dictionaryId)).get()).exists).toBe(false);
    expect((await db().doc(paths.dictionaryContent(dictionaryId)).get()).exists).toBe(false);
  });

  it('a board grant is a ceiling; either side may end it', async () => {
    const { asha, ed, vi, ben } = await people('asha', 'ed', 'vi', 'ben');
    const b = await seedBoard({ admin: asha, editors: [ed], viewers: [vi] });
    const { dictionaryId } = await call(asha, 'dictionaryCreate', { name: 'Board cfg' });
    await call(asha, 'dictionaryGrantSet', { dictionaryId, boardId: b.id, access: 'write' });

    expect((await call(vi, 'dictionaryGet', { dictionaryId })).dictionary.reach).toBe('read');
    await call(ed, 'dictionarySet', { dictionaryId, set: { K: 'ed' } });
    await expect(
      call(vi, 'dictionarySet', { dictionaryId, set: { K: 'vi' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const list = await call(vi, 'dictionaryList', { boardId: b.id });
    expect(list.dictionaries.map((d) => [d.id, d.grant])).toEqual([[dictionaryId, 'write']]);

    // Granting needs both sides: a stranger to the board cannot.
    const { dictionaryId: other } = await call(ben, 'dictionaryCreate', { name: 'Ben' });
    await expect(
      call(ben, 'dictionaryGrantSet', { dictionaryId: other, boardId: b.id, access: 'read' }),
    ).rejects.toMatchObject({ code: 'not_found' });

    // The board's admin may drop it without owning the dictionary.
    const { dictionaryId: edDict } = await call(ed, 'dictionaryCreate', { name: 'Ed' });
    await expect(
      call(ed, 'dictionaryGrantSet', { dictionaryId: edDict, boardId: b.id, access: 'read' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await call(asha, 'dictionaryGrantSet', { dictionaryId, boardId: b.id, access: null });
    await expect(call(vi, 'dictionaryGet', { dictionaryId })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('GET /v1/env: board dictionaries then the agent’s, by name; text as is, JSON as text', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const { id: agentId } = await seedAgent(asha, { boardId: b.id, role: 'editor' });
    const mk = async (name: string, entries: { key: string; value: unknown }[]) =>
      (await call(asha, 'dictionaryCreate', { name, entries })).dictionaryId;
    const a = await mk('A board', [
      { key: 'A', value: 'board' },
      { key: 'B', value: 'board-a' },
    ]);
    const z = await mk('Z board', [
      { key: 'B', value: 'board-z' },
      { key: 'J', value: { x: 1 } },
      { key: 'dotted.key', value: 'skipped' },
    ]);
    const g = await mk('Agent', [
      { key: 'B', value: 'agent' },
      { key: 'C', value: 7 },
    ]);
    const archived = await mk('Archived', [{ key: 'A', value: 'old' }]);
    for (const d of [a, z, archived])
      await call(asha, 'dictionaryGrantSet', { dictionaryId: d, boardId: b.id, access: 'read' });
    await call(asha, 'dictionaryGrantSet', { dictionaryId: g, agentId, access: 'read' });
    await call(asha, 'dictionaryUpdate', { dictionaryId: archived, archived: true });
    const { key } = await agentTokenFor(asha, agentId);

    const res = await rest(key, 'GET', `/v1/env?board=${b.key}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      board: { A: 'board', B: 'board-z', J: '{"x":1}' },
      agent: { B: 'agent', C: '7' },
      env: { A: 'board', B: 'agent', C: '7', J: '{"x":1}' },
    });
    expect((res.body as { dictionaries: { id: string; via: string }[] }).dictionaries).toEqual([
      { id: a, name: 'A board', via: 'board' },
      { id: z, name: 'Z board', via: 'board' },
      { id: g, name: 'Agent', via: 'agent' },
    ]);

    // The agent reads over REST; it writes only with a write grant.
    const one = await rest(key, 'GET', `/v1/dictionaries/${g}`);
    expect(one.status).toBe(200);
    const denied = await rest(key, 'PATCH', `/v1/dictionaries/${g}/entries`, { set: { C: 8 } });
    expect(denied.status).toBe(403);
    await call(asha, 'dictionaryGrantSet', { dictionaryId: g, agentId, access: 'write' });
    const ok = await rest(key, 'PATCH', `/v1/dictionaries/${g}/entries`, { set: { C: 8 } });
    expect(ok.status).toBe(200);
    // Never manages: granting is people's.
    const grant = await rest(key, 'POST', '/api/dictionaryGrantSet', {
      dictionaryId: a,
      boardId: b.id,
      access: 'write',
    });
    expect([401, 403]).toContain(grant.status);
  });

  it('an org-owned dictionary fans out to the org’s members', async () => {
    const { asha } = await people('asha');
    const h = `o-${Math.random().toString(36).slice(2, 10)}`;
    const { orgId } = await call(asha, 'orgCreate', { handle: h, name: 'Delta' });
    const { dictionaryId } = await call(asha, 'dictionaryCreate', {
      name: 'Org cfg',
      owner: { kind: 'org', id: orgId },
    });
    const d = (await db().doc(paths.dictionary(dictionaryId)).get()).data()!;
    expect(d).toMatchObject({ owner: { kind: 'org', id: orgId }, ownerHandle: h, slug: 'org-cfg' });
    const at = await call(asha, 'pathResolve', { handle: h, kind: 'dictionary', slug: 'org-cfg' });
    expect(at.thing).toMatchObject({ kind: 'dictionary', id: dictionaryId });
  });
});

describe('env → dictionary migration', () => {
  it('one dictionary per env, granted where it applied; idempotent', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const { id: agentId } = await seedAgent(asha, { boardId: b.id, role: 'editor' });
    await db()
      .doc(`_env/board:${b.id}`)
      .set({ vars: { REPO: 'web' }, updatedAt: 1, updatedBy: asha.uid });
    await db()
      .doc(`_env/agent:${agentId}`)
      .set({ vars: { MODEL: 'opus' }, updatedAt: 1, updatedBy: asha.uid });
    await db()
      .doc(`_env/board:gone_${b.id}`)
      .set({ vars: { X: '1' }, updatedAt: 1, updatedBy: asha.uid });

    const dry = await migrateEnvToDictionaries({ db: db(), apply: false });
    expect(dry.created).toBeGreaterThanOrEqual(2);
    expect((await db().doc(`_env/board:${b.id}`).get()).exists).toBe(true);

    await migrateEnvToDictionaries({ db: db(), apply: true });
    expect((await db().doc(`_env/board:${b.id}`).get()).exists).toBe(false);
    expect((await db().doc(`_env/board:gone_${b.id}`).get()).exists).toBe(false);
    const boardDict = envDictionaryId(`board:${b.id}`);
    const got = await call(asha, 'dictionaryGet', { dictionaryId: boardDict });
    expect(got.entries).toEqual([{ key: 'REPO', value: 'web' }]);
    expect(got.dictionary.reach).toBe('manage');
    const d = (await db().doc(paths.dictionary(boardDict)).get()).data()!;
    expect(d.boards).toEqual({ [b.id]: 'read' });

    const { key } = await agentTokenFor(asha, agentId);
    const env = await rest(key, 'GET', `/v1/env?board=${b.key}`);
    expect((env.body as { env: Record<string, string> }).env).toMatchObject({
      REPO: 'web',
      MODEL: 'opus',
    });

    const again = await migrateEnvToDictionaries({ db: db(), apply: false });
    expect(again.created).toBe(0);
  });
});

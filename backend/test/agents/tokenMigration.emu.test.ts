/**
 * §AA6 (docs/plan/agents.html §AA) — the core of scripts/migrate-agent-tokens.mjs
 * against the emulators: what it plans, what it writes, that the converted
 * tokens keep working with the same secret, and that a second run does nothing.
 *
 * THE PLAN IS GLOBAL (it reads every board, artifact and key in the database)
 * and the emulator is shared by every test file, so the assertions look at
 * THIS test's own rows — except the last one, which is the point of
 * idempotency: after an apply, a new plan is empty for everybody.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_TOKEN_SCOPES, paths, type ApiKey, type Artifact, type Board } from '@tm/shared';
import {
  applyAgentTokenMigration,
  mintedTokenName,
  planAgentTokenMigration,
} from '../../src/agents/tokenMigration.js';
import { sha256hex } from '../../src/platform/crypto.js';
import { db } from '../../src/runtime/firebase.js';
import { call, setupEmulators } from '../harness/index.js';
import { agentKeyFor, agentTokenFor, rest } from '../platform/helpers.js';
import { people, seedBoard } from '../tickets/helpers.js';
import { makeAgent } from './helpers.js';

setupEmulators();

const keyRow = async (uid: string, keyId: string) =>
  (await db().doc(paths.apiKey(uid, keyId)).get()).data() as ApiKey;

describe('§AA6 migrate-agent-tokens', () => {
  it('converts live keys, backfills agentIds, rewrites artifact agents, mints once — and is idempotent', async () => {
    const { owner } = await people('owner');
    const eng = await seedBoard({ admin: owner });
    const ops = await seedBoard({ admin: owner });

    // TWO agents: one with two live board tokens (it will be issued a new one),
    // one with a single token (it will not).
    const many = await makeAgent(owner, { name: 'Builder', boardId: eng.id });
    await call(owner, 'boardAgentSet', { boardId: ops.id, agentId: many.id, role: 'viewer' });
    const single = await makeAgent(owner, { name: 'Solo', boardId: eng.id });
    const scopes = ['board:read', 'tickets:read', 'comments:read'] as const;
    const k1 = await agentKeyFor(owner, many.id, [...scopes], eng.id, 'orch-eng');
    const k2 = await agentKeyFor(owner, many.id, [...scopes], ops.id, 'orch-ops');
    const k3 = await agentKeyFor(owner, single.id, [...scopes], eng.id, 'orch-solo');
    // A revoked and an expired key: dead already, left exactly as they are.
    const revoked = await agentKeyFor(owner, single.id, [...scopes], eng.id, 'orch-revoked');
    await call(owner, 'apiKeyRevoke', { keyId: revoked.keyId });
    const expired = await agentKeyFor(owner, single.id, [...scopes], eng.id, 'orch-expired');
    await db().doc(paths.apiKey(owner.uid, expired.keyId)).update({ expiresAt: Date.now() - 1000 });
    // A person's own board token is none of this migration's business.
    const mine = await call(owner, 'apiKeyCreate', { name: 'me', boardId: eng.id, scopes: ['board:read'] });

    // Boards and an artifact as they were written BEFORE §AA: no agentIds, the literal 'editor'.
    const { FieldValue } = await import('firebase-admin/firestore');
    await db().doc(paths.board(eng.id)).update({ agentIds: FieldValue.delete() });
    await db().doc(paths.board(ops.id)).update({ agentIds: FieldValue.delete() });
    const { artifactId } = await call(owner, 'artifactCreate', { name: 'Old dashboard' });
    await db().doc(`artifacts/${artifactId}`).update({ agents: { [many.id]: 'editor' } });

    const before = {
      k1: await keyRow(owner.uid, k1.keyId),
      k2: await keyRow(owner.uid, k2.keyId),
    };
    const now = Date.now();

    // ── THE PLAN (a dry run prints exactly this) ──
    const plan = await planAgentTokenMigration(now);
    const myKeys = plan.keys.filter((k) => k.ownerUid === owner.uid);
    expect(myKeys.map((k) => k.keyId).sort()).toEqual([k1.keyId, k2.keyId, k3.keyId].sort());
    expect(myKeys.find((k) => k.keyId === k1.keyId)).toMatchObject({
      path: paths.apiKey(owner.uid, k1.keyId),
      name: 'orch-eng',
      prefix: k1.prefix,
      agentId: many.id,
      defaultBoardId: eng.id,
    });
    expect(plan.boards.filter((b) => [eng.id, ops.id].includes(b.boardId))).toEqual(
      [
        { boardId: eng.id, key: eng.key, agentIds: [many.id, single.id].sort() },
        { boardId: ops.id, key: ops.key, agentIds: [many.id] },
      ].sort((x, y) => x.boardId.localeCompare(y.boardId)),
    );
    expect(plan.artifacts.find((a) => a.artifactId === artifactId)).toEqual({
      artifactId,
      name: 'Old dashboard',
      agents: { [many.id]: { build: true, data: 'write' } },
      rewritten: [many.id],
    });
    const myMints = plan.mints.filter((m) => m.ownerUid === owner.uid);
    expect(myMints).toEqual([
      {
        ownerUid: owner.uid,
        agentId: many.id,
        agentName: 'Builder',
        liveKeys: 2,
        name: 'Builder (agent token)',
      },
    ]);
    // The plan never carries a hash or a secret — it is what gets printed.
    const printed = JSON.stringify(plan);
    for (const secret of [k1.key, k2.key, k3.key, before.k1.hash, before.k2.hash])
      expect(printed).not.toContain(secret);
    // Planning wrote nothing.
    expect(await keyRow(owner.uid, k1.keyId)).toEqual(before.k1);

    // ── APPLY ──
    const secrets = new Map<string, string>();
    const res = await applyAgentTokenMigration(plan, now, (agentId, key) => {
      secrets.set(agentId, key);
    });

    // (a) the same secret, the same hash — now an agent token with its old board as the default.
    for (const [k, boardId] of [
      [k1, eng.id],
      [k2, ops.id],
      [k3, eng.id],
    ] as const) {
      const row = await keyRow(owner.uid, k.keyId);
      expect(row).toMatchObject({ kind: 'agent', boardId: null, defaultBoardId: boardId });
      expect([...row.scopes].sort()).toEqual([...AGENT_TOKEN_SCOPES].sort());
      expect(row.hash).toBe(sha256hex(k.key));
      expect(row.revokedAt).toBe(null);
    }
    expect((await keyRow(owner.uid, k1.keyId)).hash).toBe(before.k1.hash);
    // Dead keys and the person's own token are untouched.
    expect(await keyRow(owner.uid, revoked.keyId)).toMatchObject({ kind: 'board', boardId: eng.id });
    expect(await keyRow(owner.uid, expired.keyId)).toMatchObject({ kind: 'board', boardId: eng.id });
    expect(await keyRow(owner.uid, mine.keyId)).toMatchObject({ kind: 'board', actsAs: { kind: 'user' } });

    // (b) (c)
    expect(((await db().doc(paths.board(eng.id)).get()).data() as Board).agentIds).toEqual([many.id, single.id].sort());
    expect(((await db().doc(paths.board(ops.id)).get()).data() as Board).agentIds).toEqual([many.id]);
    expect(((await db().doc(`artifacts/${artifactId}`).get()).data() as Artifact).agents).toEqual({
      [many.id]: { build: true, data: 'write' },
    });

    // (d) ONE new token for the agent that had two — handed over exactly once, never returned.
    const minted = res.minted.filter((m) => m.ownerUid === owner.uid);
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({ agentId: many.id, name: mintedTokenName('Builder') });
    expect(JSON.stringify(res)).not.toContain(secrets.get(many.id)!);
    const newKey = secrets.get(many.id)!;
    expect(newKey).toMatch(/^tm_live_[A-Za-z0-9]{32}$/);
    expect(secrets.has(single.id)).toBe(false);
    const mintedRow = await keyRow(owner.uid, minted[0]!.keyId);
    expect(mintedRow).toMatchObject({
      kind: 'agent',
      boardId: null,
      name: 'Builder (agent token)',
      actsAs: { kind: 'agent', id: many.id },
      hash: sha256hex(newKey),
      prefix: newKey.slice(0, 12),
      revokedAt: null,
    });
    expect(mintedRow.defaultBoardId).toBeUndefined();

    // ── NOTHING WAS REVOKED: every token works, old secrets included ──
    for (const key of [k1.key, k2.key, k3.key, newKey])
      expect((await rest(key, 'GET', '/v1/me')).status).toBe(200);
    // A converted token with no board named still lands on its old board…
    const viaOld = (await rest(k2.key, 'GET', '/v1/me')).body as { kind: string; board: { key: string } };
    expect(viaOld).toMatchObject({ kind: 'agent', board: { key: ops.key }, default_board: { key: ops.key } });
    expect((await rest(k2.key, 'GET', '/v1/board')).body).toMatchObject({ key: ops.key });
    expect((await rest(k1.key, 'GET', '/v1/board')).body).toMatchObject({ key: eng.key });
    // …and now reaches the agent's other board too, when it names it.
    expect((await rest(k1.key, 'GET', `/v1/board?board=${ops.key}`)).body).toMatchObject({ key: ops.key });
    // The minted token has no default: on two boards it must name one.
    expect((await rest(newKey, 'GET', '/v1/board')).status).toBe(400);
    expect((await rest(newKey, 'GET', `/v1/board?board=${eng.key}`)).status).toBe(200);

    // ── IDEMPOTENT: a second run plans nothing and mints nothing — for anyone ──
    const again = await planAgentTokenMigration(Date.now());
    expect(again).toEqual({ keys: [], boards: [], artifacts: [], mints: [] });
    const res2 = await applyAgentTokenMigration(again, Date.now(), () => {
      throw new Error('a second run must not mint');
    });
    expect(res2).toEqual({ keys: 0, boards: 0, artifacts: 0, minted: [] });
  });

  it('an agent that already has a token of its own is not issued another', async () => {
    const { owner } = await people('owner');
    const a = await seedBoard({ admin: owner });
    const b = await seedBoard({ admin: owner });
    const agent = await makeAgent(owner, { name: 'Has one', boardId: a.id });
    await call(owner, 'boardAgentSet', { boardId: b.id, agentId: agent.id, role: 'editor' });
    await agentKeyFor(owner, agent.id, ['board:read'], a.id);
    await agentKeyFor(owner, agent.id, ['board:read'], b.id);
    // Generated in the app, keeping the old ones for now: that IS its own token.
    await agentTokenFor(owner, agent.id, { keepOthers: true });

    const plan = await planAgentTokenMigration(Date.now());
    expect(plan.keys.filter((k) => k.agentId === agent.id)).toHaveLength(2);
    expect(plan.mints.filter((m) => m.agentId === agent.id)).toEqual([]);
  });

  it('if the secret cannot be kept, the token is not created', async () => {
    const { owner } = await people('owner');
    const a = await seedBoard({ admin: owner });
    const b = await seedBoard({ admin: owner });
    const agent = await makeAgent(owner, { name: 'Unlucky', boardId: a.id });
    await call(owner, 'boardAgentSet', { boardId: b.id, agentId: agent.id, role: 'editor' });
    await agentKeyFor(owner, agent.id, ['board:read'], a.id);
    await agentKeyFor(owner, agent.id, ['board:read'], b.id);

    const plan = await planAgentTokenMigration(Date.now());
    const only = { keys: [], boards: [], artifacts: [], mints: plan.mints.filter((m) => m.agentId === agent.id) };
    expect(only.mints).toHaveLength(1);
    await expect(
      applyAgentTokenMigration(only, Date.now(), () => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
    const keys = await db().collection(paths.apiKeys(owner.uid)).where('actsAs.id', '==', agent.id).get();
    expect(keys.docs.map((d) => (d.data() as ApiKey).kind ?? 'board')).toEqual(['board', 'board']);
  });
});

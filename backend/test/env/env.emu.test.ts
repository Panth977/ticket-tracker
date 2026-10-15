/**
 * Envs (shared/src/env): key/value pairs on a board, artifact, bucket and
 * agent — who may read and write them, and GET /v1/env, which an
 * orchestrator reads to fill its agent's process environment.
 */
import { describe, expect, it } from 'vitest';
import { call, setupEmulators } from '../harness/index.js';
import { people, seedBoard } from '../tickets/helpers.js';
import { agentTokenFor, rest, seedAgent } from '../platform/helpers.js';

setupEmulators();

describe('envs', () => {
  it('a board: admins write, editors and its agents read, viewers and outsiders do not', async () => {
    const { asha, ed, vi, out } = await people('asha', 'ed', 'vi', 'out');
    const b = await seedBoard({ admin: asha, editors: [ed], viewers: [vi] });
    const target = { kind: 'board' as const, id: b.key };

    const r = await call(asha, 'envSet', { target, set: { REPO: 'web-03', DEPLOY: 'no' } });
    expect(r).toMatchObject({
      vars: { REPO: 'web-03', DEPLOY: 'no' },
      effective: { REPO: 'web-03', DEPLOY: 'no' },
    });
    await call(asha, 'envSet', { target, set: { DEPLOY: null, NODE: '22' } });
    expect((await call(ed, 'envGet', { target })).vars).toEqual({ REPO: 'web-03', NODE: '22' });

    await expect(call(ed, 'envSet', { target, set: { X: '1' } })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(call(vi, 'envGet', { target })).rejects.toMatchObject({ code: 'forbidden' });
    // An outsider is not told the board exists.
    await expect(call(out, 'envGet', { target })).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      call(asha, 'envSet', { target, set: { '1BAD': 'x' } } as never),
    ).rejects.toMatchObject({ code: 'invalid' });

    await call(asha, 'envSet', { target, replace: { ONLY: 'this' } });
    expect((await call(asha, 'envGet', { target })).vars).toEqual({ ONLY: 'this' });
  });

  it('an artifact, a bucket and an agent: their owners', async () => {
    const { asha, ben } = await people('asha', 'ben');
    const { artifactId } = await call(asha, 'artifactCreate', { name: 'Dash' });
    const { bucketId } = await call(asha, 'bucketCreate', { name: 'Files' });
    const { id: agentId } = await seedAgent(asha);
    for (const target of [
      { kind: 'artifact' as const, id: artifactId },
      { kind: 'bucket' as const, id: bucketId },
      { kind: 'agent' as const, id: agentId },
    ]) {
      await call(asha, 'envSet', { target, set: { K: target.kind } });
      expect((await call(asha, 'envGet', { target })).vars).toEqual({ K: target.kind });
      await expect(call(ben, 'envGet', { target })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(call(ben, 'envSet', { target, set: { K: 'x' } })).rejects.toMatchObject({
        code: 'forbidden',
      });
    }
  });

  it('GET /v1/env: the board env and the agent env, merged, agent winning; agents cannot write', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const { id: agentId } = await seedAgent(asha, { boardId: b.id, role: 'editor' });
    await call(asha, 'envSet', {
      target: { kind: 'board', id: b.id },
      set: { A: 'board', B: 'board' },
    });
    await call(asha, 'envSet', {
      target: { kind: 'agent', id: agentId },
      set: { B: 'agent', C: 'agent' },
    });
    const { key } = await agentTokenFor(asha, agentId);

    const res = await rest(key, 'GET', `/v1/env?board=${b.key}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      board: { A: 'board', B: 'board' },
      agent: { B: 'agent', C: 'agent' },
      env: { A: 'board', B: 'agent', C: 'agent' },
    });
    // The agent reads its board's env over the command too, but never writes it.
    const set = await rest(key, 'POST', '/api/envSet', {
      target: { kind: 'board', id: b.id },
      set: { A: 'mine' },
    });
    expect([401, 403]).toContain(set.status);
  });
});

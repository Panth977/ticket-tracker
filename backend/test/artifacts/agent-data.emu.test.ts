/**
 * §AA3–§AA4 (docs/plan/agents.html §AA) under the emulators:
 *
 *   §AA3  an agent's { build, data } on an artifact — build-only cannot touch
 *         data, data-read cannot write or publish, data-write can batch; an
 *         agent never shares, renames or deletes
 *   §AA4  the artifact's data from outside the page — every REST route and
 *         the MCP tools, the path fence, the two JSON escapes, the atomic
 *         batch, and who may (agent data permission / account owner-editor)
 *
 * Real tokens through the real doors; Firestore, RTDB and Storage emulators.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_UPLOAD_MAX_BYTES,
  artifactFirestoreDoc,
  artifactPrefix,
  artifactRtdbPath,
  artifactStorageFile,
  type Artifact,
  type ArtifactAgentAccess,
  type PublicArtifact,
  type PublicArtifactDetail,
  type Scope,
} from '@tm/shared';
import { createApp } from '../../src/http/app.js';
import { db, rtdbAdmin, storageAdmin } from '../../src/runtime/firebase.js';
import { makeAgent } from '../agents/helpers.js';
import { newBoard } from '../boards/helpers.js';
import {
  call,
  createUser,
  request,
  setupEmulators,
  uniq,
  type RawResponse,
  type TestUser,
} from '../harness/index.js';
import { agentTokenFor, apiKeyFor, rest } from '../platform/helpers.js';
import { makeZip, SITE } from './zip.js';

setupEmulators();

const artifactDoc = async (id: string) =>
  (await db().doc(`artifacts/${id}`).get()).data() as Artifact;
const fsDoc = async (id: string, path: string) =>
  (await db().doc(artifactFirestoreDoc(id, path)).get()).data();
const rtVal = async (id: string, path: string) =>
  (await rtdbAdmin().ref(artifactRtdbPath(id, path)).get()).val() as unknown;
const data = (id: string, rest_: string) => `/v1/artifacts/${id}/data/${rest_}`;

function accountKey(user: TestUser, scopes: Scope[] = ['artifacts:read', 'artifacts:write']) {
  return call(user, 'apiKeyCreate', { name: 'claude', kind: 'account' as const, scopes });
}

/** An artifact, and one of the owner's agents on it with `access` — holding THE agent token. */
async function agentOn(owner: TestUser, artifactId: string, access: ArtifactAgentAccess, name = 'Builder') {
  const agent = await makeAgent(owner, { name });
  await call(owner, 'artifactShare', { artifactId, agentId: agent.id, agentAccess: access });
  const { key } = await agentTokenFor(owner, agent.id);
  return { agent, key };
}

async function newArtifact(owner: TestUser, name = 'Dashboard'): Promise<string> {
  return (await call(owner, 'artifactCreate', { name })).artifactId;
}

const publishZip = (key: string, id: string): Promise<RawResponse> =>
  request(`/v1/artifacts/${id}/builds`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/zip' },
    body: makeZip(SITE),
  });

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

// ─── §AA3 ────────────────────────────────────────────────────────────────────

describe('§AA3 on an artifact: build and data, separately', () => {
  it('artifactShare with agentAccess stores the object; both off removes; members and the agent see it', async () => {
    const owner = await createUser({ name: 'Olive' });
    const id = await newArtifact(owner);
    const agent = await makeAgent(owner, { name: 'Reader' });

    await expect(
      call(owner, 'artifactShare', {
        artifactId: id,
        agentId: agent.id,
        agentAccess: { build: false, data: 'read' },
      }),
    ).resolves.toEqual({ ok: true, outcome: 'granted' });
    expect((await artifactDoc(id)).agents).toEqual({ [agent.id]: { build: false, data: 'read' } });

    // The owner sees what each agent may do; the agent sees its own.
    const asOwner = await accountKey(owner);
    const detail = (await rest(asOwner.key, 'GET', `/v1/artifacts/${id}`)).body as PublicArtifactDetail;
    expect(detail.members.find((m) => m.id === agent.id)).toMatchObject({
      kind: 'agent',
      name: 'Reader',
      role: 'editor',
      agent_access: { build: false, data: 'read' },
    });
    expect(detail.agent_access).toBeUndefined(); // a person has a role, not an agent_access
    const { key } = await agentTokenFor(owner, agent.id);
    const mine = (await rest(key, 'GET', '/v1/artifacts')).body as { data: PublicArtifact[] };
    expect(mine.data).toHaveLength(1);
    expect(mine.data[0]).toMatchObject({ id, agent_access: { build: false, data: 'read' } });

    // Changed in place.
    await call(owner, 'artifactShare', {
      artifactId: id,
      agentId: agent.id,
      agentAccess: { build: true, data: 'write' },
    });
    expect((await artifactDoc(id)).agents[agent.id]).toEqual({ build: true, data: 'write' });

    // "At least one must be given": nothing given is "remove the agent".
    await expect(
      call(owner, 'artifactShare', {
        artifactId: id,
        agentId: agent.id,
        agentAccess: { build: false, data: 'none' },
      }),
    ).resolves.toEqual({ ok: true, outcome: 'removed' });
    expect((await artifactDoc(id)).agents).toEqual({});
    expect(((await rest(key, 'GET', '/v1/artifacts')).body as { data: unknown[] }).data).toEqual([]);
    expect((await rest(key, 'GET', `/v1/artifacts/${id}`)).status).toBe(404);
  });

  it('REST and MCP take agent_access too', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const agent = await makeAgent(owner);
    const { key } = await accountKey(owner);

    const put = await rest(key, 'PUT', `/v1/artifacts/${id}/access`, {
      agent: agent.id,
      agent_access: { build: true, data: 'none' },
    });
    expect(put.body).toEqual({ ok: true, outcome: 'granted' });
    expect((await artifactDoc(id)).agents[agent.id]).toEqual({ build: true, data: 'none' });

    const mcp = await mcpClient(key);
    const shared = await mcp.callTool({
      name: 'artifact_share',
      arguments: { id, agent: agent.id, agent_access: { build: false, data: 'write' } },
    });
    expect(shared.isError).toBeFalsy();
    expect((await artifactDoc(id)).agents[agent.id]).toEqual({ build: false, data: 'write' });
    await mcp.close();
  });

  it('BUILD only: publishes and rolls back — and cannot touch the data', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const { key } = await agentOn(owner, id, { build: true, data: 'none' });

    expect((await rest(key, 'GET', `/v1/artifacts/${id}`)).status).toBe(200);
    const pub = await publishZip(key, id);
    expect(pub.status).toBe(201);
    const build = (pub.body as { id: string }).id;
    expect((await rest(key, 'POST', `/v1/artifacts/${id}/builds/${build}/current`)).status).toBe(200);

    // No data permission: every data route is a 403 (it IS on the artifact, so not a 404).
    expect((await rest(key, 'GET', data(id, 'firestore/scores/a'))).status).toBe(403);
    expect((await rest(key, 'GET', data(id, 'firestore/scores'))).status).toBe(403);
    expect((await rest(key, 'PUT', data(id, 'firestore/scores/a'), { n: 1 })).status).toBe(403);
    expect((await rest(key, 'POST', data(id, 'batch'), { writes: [{ op: 'delete', path: 'scores/a' }] })).status).toBe(403);
    expect((await rest(key, 'GET', data(id, 'rtdb/x'))).status).toBe(403);
    expect((await rest(key, 'PUT', data(id, 'rtdb/x'), 1)).status).toBe(403);
    expect((await rest(key, 'GET', data(id, 'files'))).status).toBe(403);
    expect(await fsDoc(id, 'scores/a')).toBeUndefined();
  });

  it('DATA read: reads — and cannot write, publish, roll back or fetch the source', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    await db().doc(artifactFirestoreDoc(id, 'scores/a')).set({ n: 1 });
    await rtdbAdmin().ref(artifactRtdbPath(id, 'live/count')).set(7);
    const { key } = await agentOn(owner, id, { build: false, data: 'read' });

    expect((await rest(key, 'GET', data(id, 'firestore/scores/a'))).body).toMatchObject({
      id: 'a',
      path: '/scores/a',
      exists: true,
      data: { n: 1 },
    });
    expect((await rest(key, 'GET', data(id, 'rtdb/live/count'))).body).toEqual({
      path: '/live/count',
      value: 7,
    });
    expect((await rest(key, 'GET', data(id, 'files'))).body).toEqual({ data: [] });

    expect((await rest(key, 'PUT', data(id, 'firestore/scores/a'), { n: 2 })).status).toBe(403);
    expect((await rest(key, 'PATCH', data(id, 'firestore/scores/a'), { n: 2 })).status).toBe(403);
    expect((await rest(key, 'DELETE', data(id, 'firestore/scores/a'))).status).toBe(403);
    expect((await rest(key, 'POST', data(id, 'firestore/scores'), { n: 2 })).status).toBe(403);
    expect((await rest(key, 'POST', data(id, 'batch'), { writes: [{ op: 'set', path: 'scores/a', data: { n: 2 } }] })).status).toBe(403);
    expect((await rest(key, 'PUT', data(id, 'rtdb/live/count'), 8)).status).toBe(403);
    expect((await rest(key, 'DELETE', data(id, 'rtdb/live/count'))).status).toBe(403);
    const up = await request(data(id, 'files/a.txt'), {
      method: 'PUT',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'text/plain' },
      body: 'hello',
    });
    expect(up.status).toBe(403);
    expect(await fsDoc(id, 'scores/a')).toEqual({ n: 1 });
    expect(await rtVal(id, 'live/count')).toBe(7);

    // Not a builder either.
    expect((await publishZip(key, id)).status).toBe(403);
    expect((await rest(key, 'GET', `/v1/artifacts/${id}/source`)).status).toBe(403);
    expect((await artifactDoc(id)).currentBuild).toBe(null);
  });

  it('DATA write: batches — and still cannot publish', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const { key } = await agentOn(owner, id, { build: false, data: 'write' });

    const res = await rest(key, 'POST', data(id, 'batch'), {
      writes: [
        { op: 'set', path: 'scores/a', data: { n: 1 } },
        { op: 'set', path: 'scores/b', data: { n: 2 } },
      ],
    });
    expect(res.body).toEqual({ ok: true, written: 2 });
    expect(await fsDoc(id, 'scores/b')).toEqual({ n: 2 });
    expect((await publishZip(key, id)).status).toBe(403);
  });

  it('an agent never shares, renames or deletes — whatever it holds', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const { key } = await agentOn(owner, id, { build: true, data: 'write' });
    const other = await makeAgent(owner, { name: 'Other' });

    expect(
      (await rest(key, 'PUT', `/v1/artifacts/${id}/access`, { agent: other.id, agent_access: { build: true, data: 'none' } })).status,
    ).toBe(403);
    expect((await rest(key, 'PATCH', `/v1/artifacts/${id}`, { name: 'Mine' })).status).toBe(403);
    expect((await rest(key, 'DELETE', `/v1/artifacts/${id}`)).status).toBe(403);
    expect(await artifactDoc(id)).toMatchObject({ name: 'Dashboard' });
    expect((await artifactDoc(id)).agents[other.id]).toBeUndefined();
  });

  it("a row from before §AA3 (the literal 'editor') still means build + write", async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const agent = await makeAgent(owner);
    await db().doc(`artifacts/${id}`).update({ [`agents.${agent.id}`]: 'editor' });
    const { key } = await agentTokenFor(owner, agent.id);

    const list = (await rest(key, 'GET', '/v1/artifacts')).body as { data: PublicArtifact[] };
    expect(list.data.map((a) => a.id)).toEqual([id]);
    expect(list.data[0]!.agent_access).toEqual({ build: true, data: 'write' });
    expect((await publishZip(key, id)).status).toBe(201);
    expect((await rest(key, 'PUT', data(id, 'firestore/scores/a'), { n: 1 })).status).toBe(200);
    // The next share of the same thing rewrites it in the object form.
    await call(owner, 'artifactShare', { artifactId: id, agentId: agent.id, role: 'editor' });
    expect((await artifactDoc(id)).agents[agent.id]).toEqual({ build: true, data: 'write' });
  });
});

// ─── §AA4 ────────────────────────────────────────────────────────────────────

describe('§AA4 who may use the data API', () => {
  it('an account token: owner and editor yes; a viewer reaches nothing (404); a board token is refused', async () => {
    const owner = await createUser();
    const editor = await createUser();
    const viewer = await createUser();
    const stranger = await createUser();
    const id = await newArtifact(owner);
    await call(owner, 'artifactShare', { artifactId: id, email: editor.email, role: 'editor' });
    await call(owner, 'artifactShare', { artifactId: id, email: viewer.email, role: 'viewer' });
    const [o, e, v, s] = await Promise.all([owner, editor, viewer, stranger].map((u) => accountKey(u)));

    expect((await rest(o!.key, 'PUT', data(id, 'firestore/notes/a'), { by: 'owner' })).status).toBe(200);
    expect((await rest(e!.key, 'PATCH', data(id, 'firestore/notes/a'), { by: 'editor' })).status).toBe(200);
    expect((await rest(e!.key, 'GET', data(id, 'firestore/notes/a'))).body).toMatchObject({
      data: { by: 'editor' },
    });
    for (const k of [v!.key, s!.key]) {
      expect((await rest(k, 'GET', data(id, 'firestore/notes/a'))).status).toBe(404);
      expect((await rest(k, 'PUT', data(id, 'firestore/notes/a'), { by: 'x' })).status).toBe(404);
      expect((await rest(k, 'GET', data(id, 'rtdb/x'))).status).toBe(404);
      expect((await rest(k, 'GET', data(id, 'files'))).status).toBe(404);
    }
    expect(await fsDoc(id, 'notes/a')).toEqual({ by: 'editor' });

    // A read-only account token reads and cannot write (the scope, not the role).
    const ro = await accountKey(owner, ['artifacts:read']);
    expect((await rest(ro.key, 'GET', data(id, 'firestore/notes/a'))).status).toBe(200);
    expect((await rest(ro.key, 'PUT', data(id, 'firestore/notes/a'), { by: 'ro' })).status).toBe(403);
    // No token at all.
    expect((await rest(null, 'GET', data(id, 'firestore/notes/a'))).status).toBe(401);
    // A BOARD token acting as a person reaches no artifact (artifacts.html §C4), data included.
    const { boardId } = await newBoard(owner);
    const board = await apiKeyFor(owner, ['artifacts:read', 'artifacts:write'], boardId);
    expect((await rest(board.key, 'GET', data(id, 'firestore/notes/a'))).status).toBe(403);
  });

  it('an archived artifact refuses writes (409) and still reads; one being deleted is a 404', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const { key } = await agentOn(owner, id, { build: false, data: 'write' });
    expect((await rest(key, 'PUT', data(id, 'firestore/notes/a'), { n: 1 })).status).toBe(200);
    await rest(key, 'PUT', data(id, 'rtdb/x'), 1);

    await call(owner, 'artifactUpdate', { artifactId: id, archived: true });
    expect((await rest(key, 'GET', data(id, 'firestore/notes/a'))).status).toBe(200);
    expect((await rest(key, 'GET', data(id, 'rtdb/x'))).status).toBe(200);
    expect((await rest(key, 'PUT', data(id, 'firestore/notes/a'), { n: 2 })).status).toBe(409);
    expect((await rest(key, 'PATCH', data(id, 'firestore/notes/a'), { n: 2 })).status).toBe(409);
    expect((await rest(key, 'DELETE', data(id, 'firestore/notes/a'))).status).toBe(409);
    expect((await rest(key, 'POST', data(id, 'firestore/notes'), { n: 2 })).status).toBe(409);
    expect((await rest(key, 'POST', data(id, 'batch'), { writes: [{ op: 'delete', path: 'notes/a' }] })).status).toBe(409);
    expect((await rest(key, 'PUT', data(id, 'rtdb/x'), 2)).status).toBe(409);
    expect((await rest(key, 'POST', data(id, 'rtdb/list'), 2)).status).toBe(409);
    expect((await rest(key, 'DELETE', data(id, 'files/a.txt'))).status).toBe(409);
    const up = await request(data(id, 'files/a.txt'), {
      method: 'PUT',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(up.status).toBe(409);
    expect(await fsDoc(id, 'notes/a')).toEqual({ n: 1 });
    expect(await rtVal(id, 'x')).toBe(1);

    await call(owner, 'artifactUpdate', { artifactId: id, archived: false });
    expect((await rest(key, 'PUT', data(id, 'firestore/notes/a'), { n: 3 })).status).toBe(200);

    // deletingAt: gone for everyone, at once.
    await db().doc(`artifacts/${id}`).update({ deletingAt: Date.now() });
    expect((await rest(key, 'GET', data(id, 'firestore/notes/a'))).status).toBe(404);
    expect((await rest(key, 'PUT', data(id, 'firestore/notes/a'), { n: 4 })).status).toBe(404);
  });
});

describe('§AA4 Firestore', () => {
  async function writer() {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const { key, agent } = await agentOn(owner, id, { build: false, data: 'write' });
    return { owner, id, key, agent };
  }

  it('set, merge, get, update (dotted paths), delete, add', async () => {
    const { id, key } = await writer();
    const doc = data(id, 'firestore/scores/2026');

    expect((await rest(key, 'GET', doc)).body).toEqual({
      id: '2026',
      path: '/scores/2026',
      exists: false,
      data: null,
    });
    expect((await rest(key, 'PUT', doc, { team: 'red', stats: { won: 1, lost: 0 }, tags: ['a'] })).body).toEqual({
      ok: true,
      id: '2026',
      path: '/scores/2026',
    });
    // It landed under the artifact's own prefix and nowhere else.
    expect(await fsDoc(id, 'scores/2026')).toEqual({ team: 'red', stats: { won: 1, lost: 0 }, tags: ['a'] });

    // PUT replaces; ?merge=1 merges.
    await rest(key, 'PUT', `${doc}?merge=1`, { coach: 'Asha' });
    expect(await fsDoc(id, 'scores/2026')).toMatchObject({ team: 'red', coach: 'Asha' });
    await rest(key, 'PUT', doc, { team: 'blue', stats: { won: 1, lost: 0 } });
    expect(await fsDoc(id, 'scores/2026')).toEqual({ team: 'blue', stats: { won: 1, lost: 0 } });

    // PATCH: a dotted key is a field path; the document must exist.
    expect((await rest(key, 'PATCH', doc, { 'stats.won': 2, note: 'x' })).status).toBe(200);
    expect(await fsDoc(id, 'scores/2026')).toEqual({ team: 'blue', stats: { won: 2, lost: 0 }, note: 'x' });
    expect((await rest(key, 'PATCH', data(id, 'firestore/scores/missing'), { a: 1 })).status).toBe(404);
    expect((await rest(key, 'PATCH', doc, {})).status).toBe(400);
    expect(await fsDoc(id, 'scores/missing')).toBeUndefined();

    // POST to a collection adds; nested collections work.
    const added = await rest(key, 'POST', data(id, 'firestore/scores/2026/entries'), { who: 'p1' });
    expect(added.status).toBe(201);
    const { id: newId, path } = added.body as { id: string; path: string };
    expect(path).toBe(`/scores/2026/entries/${newId}`);
    expect(await fsDoc(id, `scores/2026/entries/${newId}`)).toEqual({ who: 'p1' });
    // With Idempotency-Key a retry is the same document, not a second one.
    const once = await rest(key, 'POST', data(id, 'firestore/scores/2026/entries'), { who: 'p2' }, { 'idempotency-key': 'retry-1' });
    const again = await rest(key, 'POST', data(id, 'firestore/scores/2026/entries'), { who: 'p2' }, { 'idempotency-key': 'retry-1' });
    expect(again.body).toEqual(once.body);
    const all = (await rest(key, 'GET', data(id, 'firestore/scores/2026/entries'))).body as { data: unknown[] };
    expect(all.data).toHaveLength(2);

    expect((await rest(key, 'DELETE', doc)).body).toEqual({ ok: true });
    expect(await fsDoc(id, 'scores/2026')).toBeUndefined();
    expect((await rest(key, 'DELETE', doc)).status).toBe(200); // already gone is fine
  });

  it('a path says what it is: PUT needs a document, POST a collection', async () => {
    const { id, key } = await writer();
    expect((await rest(key, 'PUT', data(id, 'firestore/scores'), { n: 1 })).status).toBe(400);
    expect((await rest(key, 'POST', data(id, 'firestore/scores/a'), { n: 1 })).status).toBe(400);
    expect((await rest(key, 'GET', data(id, 'firestore'))).status).toBe(400);
    expect((await rest(key, 'PUT', data(id, 'firestore/scores/a'), [1, 2])).status).toBe(400);
    expect((await rest(key, 'PUT', data(id, 'firestore/scores/a'))).status).toBe(400); // no body
  });

  it('lists a collection: where, order_by, limit, start_after → next_cursor', async () => {
    const { id, key } = await writer();
    await rest(key, 'POST', data(id, 'batch'), {
      writes: [1, 2, 3, 4, 5].map((n) => ({
        op: 'set',
        path: `runs/r${n}`,
        data: { n, even: n % 2 === 0, tags: n > 3 ? ['late'] : ['early'], label: `run ${n}` },
      })),
    });
    const list = async (qs = '') =>
      (await rest(key, 'GET', `${data(id, 'firestore/runs')}${qs}`)).body as {
        data: { id: string; path: string; exists: boolean; data: { n: number } }[];
        next_cursor: string | null;
      };

    const all = await list();
    expect(all.data.map((d) => d.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    expect(all.data[0]).toEqual({
      id: 'r1',
      path: '/runs/r1',
      exists: true,
      data: { n: 1, even: false, tags: ['early'], label: 'run 1' },
    });
    expect(all.next_cursor).toBe(null); // fewer than the limit: nothing after it

    // Paging: the cursor is the last id of a full page.
    const p1 = await list('?limit=2');
    expect(p1.data.map((d) => d.id)).toEqual(['r1', 'r2']);
    expect(p1.next_cursor).toBe('r2');
    const p2 = await list(`?limit=2&start_after=${p1.next_cursor}`);
    expect(p2.data.map((d) => d.id)).toEqual(['r3', 'r4']);
    const p3 = await list(`?limit=2&start_after=${p2.next_cursor}`);
    expect(p3.data.map((d) => d.id)).toEqual(['r5']);
    expect(p3.next_cursor).toBe(null);

    // where (repeatable; the value is JSON when it parses) and order_by.
    expect((await list('?where=n,>,3')).data.map((d) => d.id)).toEqual(['r4', 'r5']);
    expect((await list('?where=even,==,true')).data.map((d) => d.id)).toEqual(['r2', 'r4']);
    expect((await list('?where=label,==,run 3')).data.map((d) => d.id)).toEqual(['r3']);
    expect((await list('?where=tags,array-contains,late')).data.map((d) => d.id)).toEqual(['r4', 'r5']);
    expect((await list(`?where=${encodeURIComponent('n,in,[1,5]')}`)).data.map((d) => d.id)).toEqual(['r1', 'r5']);
    expect((await list('?where=n,>,1&where=n,<,4')).data.map((d) => d.id)).toEqual(['r2', 'r3']);
    expect((await list('?order_by=n,desc&limit=2')).data.map((d) => d.data.n)).toEqual([5, 4]);
    const desc = await list('?order_by=n,desc&limit=2');
    expect((await list(`?order_by=n,desc&limit=2&start_after=${desc.next_cursor}`)).data.map((d) => d.data.n)).toEqual([3, 2]);

    // Bad queries are 400s that say why.
    const bad = async (qs: string) => (await rest(key, 'GET', `${data(id, 'firestore/runs')}${qs}`)).status;
    expect(await bad('?where=n,~,3')).toBe(400);
    expect(await bad('?where=n')).toBe(400);
    expect(await bad('?order_by=n,up')).toBe(400);
    expect(await bad('?limit=501')).toBe(400);
    expect(await bad('?limit=0')).toBe(400);
    expect(await bad('?start_after=nope')).toBe(400);
    expect(await bad(`?start_after=${encodeURIComponent('../x')}`)).toBe(400);
    expect((await list('?limit=500')).data).toHaveLength(5);
  });

  it('$date is a timestamp both ways; $serverTime is the server clock; other $-escapes are refused', async () => {
    const { id, key } = await writer();
    const iso = '2026-09-30T05:30:00.000Z';
    const before = Date.now();
    const put = await rest(key, 'PUT', data(id, 'firestore/events/e1'), {
      at: { $date: iso },
      nested: { when: { $date: '2026-01-02T03:04:05Z' }, list: [{ $date: iso }, 'x'] },
      stamped: { $serverTime: true },
      plain: { $usd: 5, $eur: 4 }, // several keys: just a map
    });
    expect(put.status).toBe(200);

    // STORED as real Firestore Timestamps — what the page's driver reads back as Date.
    const stored = (await fsDoc(id, 'events/e1'))!;
    expect(stored.at).toBeInstanceOf(Timestamp);
    expect((stored.at as Timestamp).toDate().toISOString()).toBe(iso);
    expect((stored.nested as { list: unknown[] }).list[0]).toBeInstanceOf(Timestamp);
    expect(stored.stamped).toBeInstanceOf(Timestamp);
    const stamped = (stored.stamped as Timestamp).toMillis();
    expect(stamped).toBeGreaterThanOrEqual(before - 60_000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(stored.plain).toEqual({ $usd: 5, $eur: 4 });

    // READ BACK in the same form — the round trip.
    const got = (await rest(key, 'GET', data(id, 'firestore/events/e1'))).body as { data: Record<string, unknown> };
    expect(got.data.at).toEqual({ $date: iso });
    expect(got.data.nested).toEqual({
      when: { $date: '2026-01-02T03:04:05.000Z' },
      list: [{ $date: iso }, 'x'],
    });
    expect(got.data.stamped).toEqual({ $date: new Date(stamped).toISOString() });
    // A timestamp the PAGE wrote (a Date through the driver) reads the same way.
    await db().doc(artifactFirestoreDoc(id, 'events/byPage')).set({ at: new Date(iso) });
    expect(((await rest(key, 'GET', data(id, 'firestore/events/byPage'))).body as { data: unknown }).data).toEqual({
      at: { $date: iso },
    });
    // …and filters compare against one.
    const late = await rest(key, 'GET', `${data(id, 'firestore/events')}?where=${encodeURIComponent('at,>=,{"$date":"2026-06-01T00:00:00Z"}')}`);
    expect((late.body as { data: { id: string }[] }).data.map((d) => d.id).sort()).toEqual(['byPage', 'e1']);

    // The escape space stays clean.
    const refused = async (body: unknown) => {
      const r = await rest(key, 'PUT', data(id, 'firestore/events/bad'), body);
      expect(r.status).toBe(400);
      return JSON.stringify(r.body);
    };
    expect(await refused({ a: { $inc: 1 } })).toMatch(/\$inc/);
    expect(await refused({ a: { $date: 'yesterday' } })).toMatch(/ISO/);
    expect(await refused({ a: { $serverTime: false } })).toMatch(/\$serverTime/);
    expect(await refused({ list: [{ $serverTime: true }] })).toMatch(/inside an array/);
    expect(await refused({ deep: { er: [{ x: { $delete: true } }] } })).toMatch(/deep\.er\[0\]\.x/);
    expect(await fsDoc(id, 'events/bad')).toBeUndefined();
  });

  it('a batch is all or nothing: one bad write and nothing is written', async () => {
    const { id, key } = await writer();
    await rest(key, 'PUT', data(id, 'firestore/ledger/keep'), { v: 1 });
    const batch = (writes: unknown[]) => rest(key, 'POST', data(id, 'batch'), { writes });

    // An update of a document that does not exist fails the WHOLE commit.
    const missing = await batch([
      { op: 'set', path: 'ledger/a', data: { v: 1 } },
      { op: 'delete', path: 'ledger/keep' },
      { op: 'update', path: 'ledger/nope', data: { v: 2 } },
    ]);
    expect(missing.status).toBe(404);
    expect(await fsDoc(id, 'ledger/a')).toBeUndefined();
    expect(await fsDoc(id, 'ledger/keep')).toEqual({ v: 1 });

    // A bad PATH (the fence) refuses the batch before anything is sent.
    for (const path of ['ledger/../../../boards/x', 'tickets/t1', 'a/b/reads/r1', 'ledger', '', 'ledger/__x__']) {
      const r = await batch([
        { op: 'set', path: 'ledger/b', data: { v: 1 } },
        { op: 'set', path, data: { v: 1 } },
      ]);
      expect(r.status, path).toBe(400);
    }
    // A bad VALUE too.
    const badValue = await batch([
      { op: 'set', path: 'ledger/b', data: { v: 1 } },
      { op: 'set', path: 'ledger/c', data: { v: { $nope: 1 } } },
    ]);
    expect(badValue.status).toBe(400);
    expect(JSON.stringify(badValue.body)).toMatch(/writes\[1\]/);
    expect(await fsDoc(id, 'ledger/b')).toBeUndefined();
    // Too many, or none.
    expect((await batch([])).status).toBe(400);
    expect((await batch(Array.from({ length: 401 }, (_, i) => ({ op: 'delete', path: `ledger/x${i}` })))).status).toBe(400);

    // A good one: set, merge, update, delete together — and 400 of them is fine.
    const ok = await batch([
      { op: 'set', path: 'ledger/a', data: { v: 1, at: { $serverTime: true } } },
      { op: 'set', path: 'ledger/keep', data: { extra: true }, merge: true },
      { op: 'update', path: 'ledger/keep', data: { v: 2 } },
      { op: 'delete', path: 'ledger/gone' },
    ]);
    expect(ok.body).toEqual({ ok: true, written: 4 });
    expect(await fsDoc(id, 'ledger/keep')).toEqual({ v: 2, extra: true });
    expect((await fsDoc(id, 'ledger/a'))!.at).toBeInstanceOf(Timestamp);
    const big = await batch(Array.from({ length: 400 }, (_, i) => ({ op: 'set', path: `bulk/d${i}`, data: { i } })));
    expect(big.body).toEqual({ ok: true, written: 400 });
    expect((await db().collection(`${artifactPrefix.firestore(id)}/bulk`).count().get()).data().count).toBe(400);
  });

  it('the fence: reserved collections, "..", and paths that look absolute all stay inside', async () => {
    const { owner, id, key } = await writer();
    const other = await newArtifact(owner, 'Another');
    await db().doc(artifactFirestoreDoc(other, 'secret/s')).set({ v: 'theirs' });

    // The two collection names the app's collection-group rules would expose.
    for (const p of ['tickets/t1', 'reads/r1', 'a/b/tickets/t1', 'a/b/reads/r1']) {
      expect((await rest(key, 'PUT', data(id, `firestore/${p}`), { x: 1 })).status, p).toBe(400);
      expect((await rest(key, 'GET', data(id, `firestore/${p}`))).status, p).toBe(400);
    }
    expect((await rest(key, 'GET', data(id, 'firestore/tickets'))).status).toBe(400);
    expect((await rest(key, 'POST', data(id, 'firestore/reads'), { x: 1 })).status).toBe(400);

    // '..' cannot be smuggled in encoded: the path is decoded whole, then judged.
    const dots = encodeURIComponent(`x/../../../${other}/db/data/secret/s`);
    expect((await rest(key, 'GET', data(id, `firestore/${dots}`))).status).toBe(400);
    expect((await rest(key, 'PUT', data(id, `firestore/a/${encodeURIComponent('..')}`), { x: 1 })).status).toBe(400);
    expect((await rest(key, 'GET', data(id, 'firestore/a/%E0%A4%A'))).status).toBe(400); // bad encoding
    expect((await rest(key, 'GET', data(id, 'firestore/__a__/b'))).status).toBe(400);

    // A path that LOOKS absolute is just a path in this artifact's own view:
    // it lands under this artifact's prefix, and the other artifact is untouched.
    const abs = `artifacts/${other}/db/data/secret/s`; // 6 segments: a document
    expect((await rest(key, 'PUT', data(id, `firestore/${abs}`), { v: 'mine' })).status).toBe(200);
    expect(await fsDoc(id, abs)).toEqual({ v: 'mine' });
    expect(await fsDoc(other, 'secret/s')).toEqual({ v: 'theirs' });
    const viaBatch = await rest(key, 'POST', data(id, 'batch'), {
      writes: [{ op: 'set', path: `/artifacts/${other}/db/data/secret/s`, data: { v: 'mine again' } }],
    });
    expect(viaBatch.status).toBe(200);
    expect(await fsDoc(other, 'secret/s')).toEqual({ v: 'theirs' });
    // Nothing of this agent's reaches the other artifact by id either.
    expect((await rest(key, 'GET', data(other, 'firestore/secret/s'))).status).toBe(404);
  });

  it('a body over the limit is a 413', async () => {
    const { id, key } = await writer();
    const r = await rest(key, 'PUT', data(id, 'firestore/big/doc'), { blob: 'x'.repeat(2 * 1024 * 1024 + 10) });
    expect(r.status).toBe(413);
    expect(await fsDoc(id, 'big/doc')).toBeUndefined();
  });
});

describe('§AA4 Realtime Database', () => {
  it('get, set, update, push, remove — under the artifact and nowhere else', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const { key } = await agentOn(owner, id, { build: false, data: 'write' });
    const rt = (p: string) => data(id, `rtdb/${p}`);

    expect((await rest(key, 'GET', rt('game'))).body).toEqual({ path: '/game', value: null });
    expect((await rest(key, 'PUT', rt('game'), { score: 1, players: { a: true } })).body).toEqual({ ok: true });
    expect(await rtVal(id, 'game')).toEqual({ score: 1, players: { a: true } });
    expect((await rest(key, 'GET', rt('game/score'))).body).toEqual({ path: '/game/score', value: 1 });

    // PATCH changes the named children and leaves the others; a key may be a relative path.
    expect((await rest(key, 'PATCH', rt('game'), { score: 2, 'players/b': true })).status).toBe(200);
    expect(await rtVal(id, 'game')).toEqual({ score: 2, players: { a: true, b: true } });
    expect((await rest(key, 'PATCH', rt('game'), 5)).status).toBe(400);
    expect((await rest(key, 'PATCH', rt('game'), {})).status).toBe(400);
    expect((await rest(key, 'PATCH', rt('game'), { '../../x': 1 })).status).toBe(400);

    // POST pushes a child with a generated key.
    const pushed = await rest(key, 'POST', rt('log'), { msg: 'hi' });
    expect(pushed.status).toBe(201);
    const { key: childKey, path } = pushed.body as { key: string; path: string };
    expect(path).toBe(`/log/${childKey}`);
    expect(await rtVal(id, `log/${childKey}`)).toEqual({ msg: 'hi' });

    // $serverTime is the database's clock; $date is that instant in milliseconds.
    const before = Date.now();
    await rest(key, 'PUT', rt('clock'), { now: { $serverTime: true }, then: { $date: '2026-09-30T05:30:00Z' } });
    const clock = (await rtVal(id, 'clock')) as { now: number; then: number };
    expect(clock.then).toBe(Date.parse('2026-09-30T05:30:00Z'));
    expect(clock.now).toBeGreaterThanOrEqual(before - 60_000);
    expect((await rest(key, 'PUT', rt('clock'), { x: { $inc: 1 } })).status).toBe(400);

    // The root of the artifact's own tree is a real address.
    const root = (await rest(key, 'GET', data(id, 'rtdb'))).body as { path: string; value: Record<string, unknown> };
    expect(root.path).toBe('/');
    expect(Object.keys(root.value).sort()).toEqual(['clock', 'game', 'log']);

    // Keys RTDB cannot hold, and '..', are refused by the fence.
    expect((await rest(key, 'PUT', rt(encodeURIComponent('a.b')), 1)).status).toBe(400);
    expect((await rest(key, 'PUT', rt(encodeURIComponent('a/../../x')), 1)).status).toBe(400);
    expect((await rest(key, 'PUT', rt(encodeURIComponent('a$b')), 1)).status).toBe(400);

    expect((await rest(key, 'DELETE', rt('game'))).body).toEqual({ ok: true });
    expect(await rtVal(id, 'game')).toBe(null);
    // Nothing was written outside artifactData/{id}.
    expect((await rtdbAdmin().ref('x').get()).val()).toBe(null);
  });
});

describe('§AA4 files', () => {
  it('upload (raw body), list by prefix, url, delete', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const { key } = await agentOn(owner, id, { build: false, data: 'write' });
    const put = (p: string, body: string | Uint8Array, type?: string) =>
      request(data(id, `files/${p}`), {
        method: 'PUT',
        headers: { authorization: `Bearer ${key}`, ...(type ? { 'content-type': type } : {}) },
        body: body as BodyInit,
      });

    const up = await put('reports/q3.csv', 'a,b\n1,2\n', 'text/csv');
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ path: '/reports/q3.csv', size: 8, content_type: 'text/csv' });
    await put('reports/deep/q4.csv', 'x', 'text/csv');
    await put('logo.png', new Uint8Array([1, 2, 3]), 'image/png');

    // Stored under artifacts/{id}/files/ with the Content-Type of the request.
    const [meta] = await storageAdmin().bucket().file(artifactStorageFile(id, 'reports/q3.csv')).getMetadata();
    expect(meta.contentType).toBe('text/csv');
    const [bytes] = await storageAdmin().bucket().file(artifactStorageFile(id, 'reports/q3.csv')).download();
    expect(bytes.toString()).toBe('a,b\n1,2\n');

    const all = (await rest(key, 'GET', data(id, 'files'))).body as { data: { path: string; size: number; content_type: string }[] };
    expect(all.data.map((f) => f.path).sort()).toEqual(['/logo.png', '/reports/deep/q4.csv', '/reports/q3.csv']);
    const some = (await rest(key, 'GET', data(id, 'files?prefix=reports'))).body as { data: { path: string }[] };
    expect(some.data.map((f) => f.path).sort()).toEqual(['/reports/deep/q4.csv', '/reports/q3.csv']);
    expect(all.data.find((f) => f.path === '/logo.png')).toMatchObject({ size: 3, content_type: 'image/png' });

    // A link that needs no Authorization header — the same one the page is handed.
    const link = await rest(key, 'GET', data(id, 'files/reports/q3.csv'));
    expect(link.status).toBe(200);
    const { url, expires_at } = link.body as { url: string; expires_at: string };
    expect(Date.parse(expires_at)).toBeGreaterThan(Date.now());
    const fetched = await (await createApp()).request(url.slice(url.indexOf('/c/')));
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe('a,b\n1,2\n');
    expect((await rest(key, 'GET', data(id, 'files/reports/none.csv'))).status).toBe(404);

    // The fence.
    expect((await put(encodeURIComponent('../../builds/evil.html'), 'x', 'text/html')).status).toBe(400);
    expect((await put(encodeURIComponent('a/../../b'), 'x')).status).toBe(400);
    expect((await rest(key, 'GET', data(id, `files?prefix=${encodeURIComponent('../')}`))).status).toBe(400);
    const objects = (await storageAdmin().bucket().getFiles({ prefix: artifactPrefix.storageAll(id) }))[0].map((f) => f.name);
    expect(objects.every((n) => n.startsWith(`${artifactPrefix.storageFiles(id)}/`))).toBe(true);

    expect((await rest(key, 'DELETE', data(id, 'files/reports/q3.csv'))).body).toEqual({ ok: true });
    expect((await rest(key, 'DELETE', data(id, 'files/reports/q3.csv'))).status).toBe(200);
    const left = (await rest(key, 'GET', data(id, 'files'))).body as { data: { path: string }[] };
    expect(left.data.map((f) => f.path).sort()).toEqual(['/logo.png', '/reports/deep/q4.csv']);
  });

  it('a file over 25 MB is a 413', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const { key } = await agentOn(owner, id, { build: false, data: 'write' });
    const r = await request(data(id, 'files/huge.bin'), {
      method: 'PUT',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(ARTIFACT_UPLOAD_MAX_BYTES + 1),
    });
    expect(r.status).toBe(413);
    expect((await storageAdmin().bucket().file(artifactStorageFile(id, 'huge.bin')).exists())[0]).toBe(false);
  });
});

describe('§AA4 MCP: artifact_data_get / list / set / batch', () => {
  it('the same fence and the same permission as REST', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const { key } = await agentOn(owner, id, { build: false, data: 'write' });
    const reader = await agentOn(owner, id, { build: false, data: 'read' }, uniq('Reader'));
    const mcp = await mcpClient(key);
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r = await mcp.callTool({ name, arguments: args });
      return { error: r.isError === true, text: text(r) };
    };
    const ok = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      const r = await tool(name, args);
      expect(r.error, r.text).toBe(false);
      return JSON.parse(r.text) as T;
    };

    const names = (await mcp.listTools()).tools.map((t) => t.name);
    for (const n of ['artifact_data_get', 'artifact_data_list', 'artifact_data_set', 'artifact_data_batch'])
      expect(names).toContain(n);

    expect(await ok('artifact_data_set', { id, path: 'kpi/today', data: { n: 1, at: { $date: '2026-09-30T05:30:00Z' } } })).toEqual({
      ok: true,
      id: 'today',
      path: '/kpi/today',
    });
    await ok('artifact_data_set', { id, path: 'kpi/today', data: { m: 2 }, merge: true });
    expect(await ok('artifact_data_get', { id, path: 'kpi/today' })).toEqual({
      id: 'today',
      path: '/kpi/today',
      exists: true,
      data: { n: 1, m: 2, at: { $date: '2026-09-30T05:30:00.000Z' } },
    });
    expect(
      await ok('artifact_data_batch', {
        id,
        writes: [
          { op: 'set', path: 'kpi/a', data: { n: 5 } },
          { op: 'set', path: 'kpi/b', data: { n: 9 } },
          { op: 'update', path: 'kpi/today', data: { n: 3 } },
        ],
      }),
    ).toEqual({ ok: true, written: 3 });
    const listed = await ok<{ data: { id: string }[]; next_cursor: string | null }>('artifact_data_list', {
      id,
      path: 'kpi',
      where: [['n', '>=', 3]],
      order_by: 'n,desc',
      limit: 2,
    });
    expect(listed.data.map((d) => d.id)).toEqual(['b', 'a']);
    expect(listed.next_cursor).toBe('a');
    const next = await ok<{ data: { id: string }[] }>('artifact_data_list', {
      id,
      path: 'kpi',
      where: [['n', '>=', 3]],
      order_by: 'n,desc',
      limit: 2,
      start_after: listed.next_cursor,
    });
    expect(next.data.map((d) => d.id)).toEqual(['today']);

    // The fence, reached without a URL to normalise anything away.
    for (const path of ['kpi/../../../boards/x', 'tickets/t1', 'kpi', '../x/y']) {
      const r = await tool('artifact_data_set', { id, path, data: { x: 1 } });
      expect(r.error, path).toBe(true);
      expect(r.text).toMatch(/^invalid/);
    }
    const atomic = await tool('artifact_data_batch', {
      id,
      writes: [
        { op: 'set', path: 'kpi/z', data: { n: 1 } },
        { op: 'set', path: 'kpi/../z2', data: { n: 1 } },
      ],
    });
    expect(atomic.error).toBe(true);
    expect(await fsDoc(id, 'kpi/z')).toBeUndefined();
    await mcp.close();

    // A data-READ agent: get and list, never set or batch.
    const ro = await mcpClient(reader.key);
    expect((await ro.callTool({ name: 'artifact_data_get', arguments: { id, path: 'kpi/a' } })).isError).toBeFalsy();
    const denied = await ro.callTool({ name: 'artifact_data_set', arguments: { id, path: 'kpi/a', data: { n: 0 } } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/^forbidden/);
    const denied2 = await ro.callTool({ name: 'artifact_data_batch', arguments: { id, writes: [{ op: 'delete', path: 'kpi/a' }] } });
    expect(denied2.isError).toBe(true);
    expect(await fsDoc(id, 'kpi/a')).toEqual({ n: 5 });
    await ro.close();
  });
});

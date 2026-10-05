/**
 * ARTIFACTS end to end under the emulators (docs/plan/artifacts.html):
 * the commands through the app door, the /c file route, REST and MCP with
 * account and agent tokens, sharing → invite → accept, the delete queue and
 * housekeeping. Real ID tokens, real Firestore / RTDB / Storage emulators.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_BUILDS_KEPT,
  ARTIFACT_CAPABILITY_TTL_MS,
  ARTIFACT_INVITE_BOARD_ID,
  ARTIFACT_UPLOAD_TTL_MS,
  artifactFirestoreDoc,
  artifactKvDoc,
  artifactPrefix,
  artifactRtdbPath,
  artifactStorageFile,
  paths,
  type Artifact,
  type ArtifactBuild,
  type InboxItem,
  type Invite,
  type PublicArtifact,
  type PublicArtifactBuild,
  type PublicArtifactDetail,
  type Scope,
} from '@tm/shared';
import { artifactHousekeeping } from '../../src/artifacts/housekeeping.js';
import { createApp } from '../../src/http/app.js';
import { db, rtdbAdmin, storageAdmin } from '../../src/runtime/firebase.js';
import { newBoard } from '../boards/helpers.js';
import {
  call,
  callRaw,
  createUser,
  devOutbox,
  fixedClock,
  queue,
  request,
  setPorts,
  setupEmulators,
  uniq,
  type TestUser,
} from '../harness/index.js';
import { agentKeyFor, apiKeyFor, rest, seedAgent } from '../platform/helpers.js';
import { makeZip, SITE, type ZipEntrySpec } from './zip.js';

setupEmulators();

/** Tests that swap ports (the clock, the queue) only make sense in-process. */
const inProcess = it.skipIf(!!process.env.TM_API_URL);

const bucket = () => storageAdmin().bucket();
const artifactDoc = async (id: string) =>
  (await db().doc(`artifacts/${id}`).get()).data() as Artifact | undefined;
const buildDoc = async (id: string, b: string) =>
  (await db().doc(`artifacts/${id}/builds/${b}`).get()).data() as ArtifactBuild | undefined;
const stored = async (prefix: string) =>
  (await bucket().getFiles({ prefix }))[0].map((f) => f.name).sort();
const mirror = async (id: string) => ({
  readers: (await rtdbAdmin().ref(artifactPrefix.rtdbReaders(id)).get()).val() as Record<
    string,
    string
  > | null,
  flags: (await rtdbAdmin().ref(artifactPrefix.rtdbFlags(id)).get()).val() as {
    readOnly: boolean;
    archived: boolean;
  } | null,
});

async function newArtifact(owner: TestUser, name = 'Sales dashboard'): Promise<string> {
  return (await call(owner, 'artifactCreate', { name })).artifactId;
}

/** Put a zip where the app's Builds tab would (Storage rules are the app's business, not ours). */
async function upload(artifactId: string, zip: Buffer): Promise<string> {
  const path = artifactPrefix.storageUpload(artifactId, uniq('up'));
  await bucket().file(path).save(zip, { contentType: 'application/zip', resumable: false });
  return path;
}

async function publish(
  who: TestUser,
  artifactId: string,
  entries: ZipEntrySpec[] = SITE,
  extra: { message?: string; source?: Buffer } = {},
) {
  return call(who, 'artifactPublish', {
    artifactId,
    uploadPath: await upload(artifactId, makeZip(entries)),
    ...(extra.source ? { sourceUploadPath: await upload(artifactId, extra.source) } : {}),
    ...(extra.message ? { message: extra.message } : {}),
  });
}

/** '{origin}/c/{cap}/x' → '/c/{cap}/x' — the path the api function sees. */
const pathOf = (url: string) => url.slice(url.indexOf('/c/'));

/** owner + an editor and a viewer (both with accounts) + somebody with no role. */
async function scene() {
  const owner = await createUser({ name: 'Olive Owner' });
  const editor = await createUser({ name: 'Ed Editor' });
  const viewer = await createUser({ name: 'Vi Viewer' });
  const stranger = await createUser({ name: 'Sam Stranger' });
  const id = await newArtifact(owner);
  await call(owner, 'artifactShare', { artifactId: id, email: editor.email, role: 'editor' });
  await call(owner, 'artifactShare', { artifactId: id, email: viewer.email, role: 'viewer' });
  return { owner, editor, viewer, stranger, id };
}

const accountKeyFor = (user: TestUser, scopes: Scope[], name = 'claude') =>
  call(user, 'apiKeyCreate', { name, kind: 'account' as const, scopes });

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
const toolError = (r: unknown): string | null =>
  (r as { isError?: boolean }).isError
    ? (r as { content: { text: string }[] }).content[0]!.text
    : null;

// ─────────────────────────────────────────────────────────────────────────────

describe('artifactCreate', () => {
  it('makes an empty artifact owned by the caller, with its RTDB mirror', async () => {
    const owner = await createUser({ name: 'Olive' });
    const { artifactId } = await call(owner, 'artifactCreate', {
      name: '  Sales dashboard ',
      description: 'Weekly numbers',
      icon: '📈',
    });
    expect(artifactId).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
    expect(await artifactDoc(artifactId)).toMatchObject({
      name: 'Sales dashboard',
      description: 'Weekly numbers',
      icon: '📈',
      ownerUid: owner.uid,
      access: { [owner.uid]: 'owner' },
      memberUids: [owner.uid],
      agents: {},
      readOnly: false,
      archivedAt: null,
      currentBuild: null,
    });
    expect(await mirror(artifactId)).toEqual({
      readers: { [owner.uid]: 'owner' },
      flags: { readOnly: false, archived: false },
    });
  });

  it('is found by the query the app uses: where(memberUids array-contains me)', async () => {
    const { owner, viewer, stranger, id } = await scene();
    const mine = async (u: TestUser) =>
      (
        await db().collection('artifacts').where('memberUids', 'array-contains', u.uid).get()
      ).docs.map((d) => d.id);
    expect(await mine(owner)).toContain(id);
    expect(await mine(viewer)).toContain(id);
    expect(await mine(stranger)).not.toContain(id);
  });

  it('an agent creates one FOR ITS OWNER (needs artifacts:write); a board token cannot', async () => {
    const owner = await createUser();
    const { boardId } = await newBoard(owner);
    const agent = await seedAgent(owner, { boardId, name: 'Builder' });
    const agentKey = await agentKeyFor(
      owner,
      agent.id,
      ['artifacts:read', 'artifacts:write'],
      boardId,
    );
    const r = await rest(agentKey.key, 'POST', '/v1/artifacts', { name: 'Made by the agent' });
    expect(r.status).toBe(201);
    const made = r.body as PublicArtifact;
    // The PERSON owns it and finds it in their own list. §AA3 changed what the
    // agent is on it: no longer the literal 'editor' but { build, data } — it
    // may build what it made and write its data — and it is told so.
    expect(made).toMatchObject({
      role: 'editor',
      owner_id: owner.uid,
      agent_access: { build: true, data: 'write' },
    });
    const doc = (await db().doc(`artifacts/${made.id}`).get()).data()!;
    expect(doc).toMatchObject({
      ownerUid: owner.uid,
      access: { [owner.uid]: 'owner' },
      memberUids: [owner.uid],
      // §AA3: writers store the OBJECT form from now on.
      agents: { [agent.id]: { build: true, data: 'write' } },
    });
    // …and is told, since nobody clicked anything to make it.
    const row = (
      await db()
        .doc(paths.inboxItem(owner.uid, `artifact_${made.id}`))
        .get()
    ).data() as InboxItem;
    expect(row).toMatchObject({ artifactId: made.id });
    expect(row.summary).toMatch(/Builder created the artifact/);
    // It can publish to what it made, and still owns nothing: no deleting.
    const pub = await request(`/v1/artifacts/${made.id}/builds`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentKey.key}`, 'content-type': 'application/zip' },
      body: makeZip(SITE),
    });
    expect(pub.status).toBe(201);
    expect((await rest(agentKey.key, 'DELETE', `/v1/artifacts/${made.id}`)).status).toBe(403);

    // Without the scope the token never reaches the command.
    const noScope = await agentKeyFor(owner, agent.id, ['tickets:read'], boardId);
    expect((await rest(noScope.key, 'POST', '/v1/artifacts', { name: 'Nope' })).status).toBe(403);

    const boardKey = await apiKeyFor(owner, ['artifacts:write'], boardId);
    const b = await rest(boardKey.key, 'POST', '/v1/artifacts', { name: 'Nope' });
    expect(b.status).toBe(403);
    expect((b.body as { detail: string }).detail).toMatch(/account token/i);
  });
});

describe('the role table (§B)', () => {
  it('owner / editor / viewer / nobody against every command', async () => {
    const { owner, editor, viewer, stranger, id } = await scene();
    const { buildId } = await publish(owner, id);

    // No role at all → 404, for everything: artifacts are private.
    for (const [name, input] of [
      ['artifactOpen', { artifactId: id }],
      ['artifactUpdate', { artifactId: id, name: 'x' }],
      ['artifactShare', { artifactId: id, email: 'a@b.dev', role: 'viewer' }],
      ['artifactPublish', { artifactId: id, files: [{ path: 'index.html', content: 'x' }] }],
      ['artifactSetCurrent', { artifactId: id, buildId }],
      ['artifactSourceUrl', { artifactId: id }],
      ['artifactFileList', { artifactId: id }],
      ['artifactFileUrl', { artifactId: id, path: '/a.png' }],
      ['artifactFileDelete', { artifactId: id, path: '/a.png' }],
      ['artifactDataClear', { artifactId: id }],
      ['artifactDelete', { artifactId: id }],
    ] as const) {
      const r = await callRaw(stranger, name, input);
      expect(r.status, name).toBe(404);
    }
    // …and an id that does not exist looks exactly the same.
    expect((await callRaw(owner, 'artifactOpen', { artifactId: 'nope00000000' })).status).toBe(404);

    // Open: every role.
    for (const who of [owner, editor, viewer])
      await expect(call(who, 'artifactOpen', { artifactId: id })).resolves.toMatchObject({
        buildId,
      });

    // Publish / roll back / source: owner and editor; a viewer is refused (403, not 404).
    for (const who of [owner, editor])
      await expect(call(who, 'artifactSetCurrent', { artifactId: id, buildId })).resolves.toEqual({
        ok: true,
      });
    for (const [name, input] of [
      ['artifactPublish', { artifactId: id, files: [{ path: 'index.html', content: 'x' }] }],
      ['artifactSetCurrent', { artifactId: id, buildId }],
      ['artifactSourceUrl', { artifactId: id }],
    ] as const)
      expect((await callRaw(viewer, name, input)).status, name).toBe(403);

    // Rename, share, clear, delete: the owner alone.
    for (const who of [editor, viewer])
      for (const [name, input] of [
        ['artifactUpdate', { artifactId: id, name: 'Mine now' }],
        ['artifactShare', { artifactId: id, email: stranger.email, role: 'editor' }],
        ['artifactDataClear', { artifactId: id }],
        ['artifactDelete', { artifactId: id }],
      ] as const)
        expect((await callRaw(who, name, input)).status, `${name} by ${who.displayName}`).toBe(403);
    await expect(
      call(owner, 'artifactUpdate', { artifactId: id, name: 'Renamed' }),
    ).resolves.toEqual({ ok: true });
    expect((await artifactDoc(id))!.name).toBe('Renamed');
  });

  it('artifactOpen says whether THIS viewer may write, and the mirror follows the switches', async () => {
    const { owner, editor, viewer, id } = await scene();
    await publish(owner, id);
    const readOnly = async (who: TestUser) =>
      (await call(who, 'artifactOpen', { artifactId: id })).readOnly;

    expect([await readOnly(owner), await readOnly(editor), await readOnly(viewer)]).toEqual([
      false,
      false,
      false,
    ]);
    await call(owner, 'artifactUpdate', { artifactId: id, readOnly: true });
    expect([await readOnly(owner), await readOnly(editor), await readOnly(viewer)]).toEqual([
      false,
      false,
      true,
    ]);
    expect((await mirror(id)).flags).toEqual({ readOnly: true, archived: false });

    await call(owner, 'artifactUpdate', { artifactId: id, archived: true });
    expect((await artifactDoc(id))!.archivedAt).toEqual(expect.any(Number));
    expect([await readOnly(owner), await readOnly(editor), await readOnly(viewer)]).toEqual([
      true,
      true,
      true,
    ]);
    expect((await mirror(id)).flags).toEqual({ readOnly: true, archived: true });
    // Archived: nothing is published until it is restored.
    await expect(publish(owner, id)).rejects.toMatchObject({ code: 'conflict' });
    await call(owner, 'artifactUpdate', { artifactId: id, archived: false });
    expect((await artifactDoc(id))!.archivedAt).toBe(null);
  });

  it('a viewer of a read-only artifact cannot delete its files; an editor can', async () => {
    const { owner, editor, viewer, id } = await scene();
    const path = artifactStorageFile(id, '/pics/cat.png');
    await bucket()
      .file(path)
      .save(Buffer.from('png'), { contentType: 'image/png', resumable: false });

    await call(owner, 'artifactUpdate', { artifactId: id, readOnly: true });
    await expect(
      call(viewer, 'artifactFileDelete', { artifactId: id, path: '/pics/cat.png' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await bucket().file(path).exists())[0]).toBe(true);
    await call(editor, 'artifactFileDelete', { artifactId: id, path: '/pics/cat.png' });
    expect((await bucket().file(path).exists())[0]).toBe(false);
    // Escaping the prefix is a 400, never a delete somewhere else.
    await expect(
      call(editor, 'artifactFileDelete', { artifactId: id, path: '/../../x' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('artifactPublish', () => {
  it('unpacks a real zip: files with content types, the build document, current, upload gone', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const uploadPath = await upload(
      id,
      makeZip([
        ...SITE.map((e) => ({ ...e, name: `dist/${e.name}` })), // a zipped dist/ folder
        { name: 'dist/assets/logo.svg', data: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
        { name: '__MACOSX/dist/._index.html', data: 'junk' },
      ]),
    );
    const res = await call(owner, 'artifactPublish', {
      artifactId: id,
      uploadPath,
      message: 'first cut',
    });
    expect(res).toMatchObject({ files: 4, warnings: [] });
    expect(res.bytes).toBeGreaterThan(100);

    const prefix = `${artifactPrefix.storageBuild(id, res.buildId)}/`;
    expect(await stored(prefix)).toEqual(
      ['assets/app.css', 'assets/app.js', 'assets/logo.svg', 'index.html'].map((p) => prefix + p),
    );
    const type = async (p: string) =>
      (
        await bucket()
          .file(prefix + p)
          .getMetadata()
      )[0].contentType;
    expect(await type('index.html')).toBe('text/html; charset=utf-8');
    expect(await type('assets/app.js')).toBe('text/javascript; charset=utf-8');
    expect(await type('assets/app.css')).toBe('text/css; charset=utf-8');
    expect(await type('assets/logo.svg')).toBe('image/svg+xml');

    expect(await buildDoc(id, res.buildId)).toMatchObject({
      files: 4,
      bytes: res.bytes,
      message: 'first cut',
      sourcePath: null,
      by: owner.uid,
      warnings: [],
    });
    expect((await artifactDoc(id))!.currentBuild).toBe(res.buildId);
    // The upload zip is single-use.
    expect((await bucket().file(uploadPath).exists())[0]).toBe(false);
  });

  it('warns — and still publishes — when index.html loads assets by absolute path', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const res = await publish(owner, id, [
      { name: 'index.html', data: '<script type="module" src="/assets/app.js"></script>' },
      { name: 'assets/app.js', data: '1' },
    ]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/base: '\.\/'/);
    expect((await buildDoc(id, res.buildId))!.warnings).toEqual(res.warnings);
  });

  it('publishes inline files (what MCP sends), utf8 and base64', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const res = await call(owner, 'artifactPublish', {
      artifactId: id,
      files: [
        { path: 'index.html', content: '<h1>hi</h1>' },
        {
          path: 'img/dot.bin',
          content: Buffer.from([0, 1, 2, 255]).toString('base64'),
          encoding: 'base64',
        },
      ],
    });
    expect(res).toMatchObject({ files: 2, bytes: 15 });
    const [bytes] = await bucket()
      .file(`${artifactPrefix.storageBuild(id, res.buildId)}/img/dot.bin`)
      .download();
    expect([...bytes]).toEqual([0, 1, 2, 255]);
  });

  it.each([
    [
      'a path that climbs out of the folder (zip-slip)',
      [...SITE, { name: '../../evil.html', data: 'pwn' }],
      'invalid',
    ],
    ['an absolute path', [...SITE, { name: '/etc/passwd', data: 'pwn' }], 'invalid'],
    [
      'a symlink',
      [...SITE, { name: 'link', data: '/etc/passwd', method: 'store', mode: 0o120777 }],
      'invalid',
    ],
    ['no index.html', [{ name: 'app.js', data: '1' }], 'invalid'],
    [
      'two top folders and no index at the root',
      [
        { name: 'a/index.html', data: '1' },
        { name: 'b/x.js', data: '1' },
      ],
      'invalid',
    ],
    [
      'more unpacked bytes than a build may have',
      [{ name: 'index.html', data: new Uint8Array(26 * 1024 * 1024) }],
      'too_large',
    ],
  ] as [string, ZipEntrySpec[], string][])(
    'refuses %s, and leaves nothing behind',
    async (_what, entries, code) => {
      const owner = await createUser();
      const id = await newArtifact(owner);
      const uploadPath = await upload(id, makeZip(entries));
      await expect(
        call(owner, 'artifactPublish', { artifactId: id, uploadPath }),
      ).rejects.toMatchObject({ code });
      // No build document, no current build, no half-written files, no leftover upload.
      expect((await artifactDoc(id))!.currentBuild).toBe(null);
      expect((await db().collection(`artifacts/${id}/builds`).get()).size).toBe(0);
      expect(await stored(artifactPrefix.storageAll(id))).toEqual([]);
    },
  );

  it('A ZIP BOMB — 100 bytes declared, megabytes inflated — is refused while it inflates', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const uploadPath = await upload(
      id,
      makeZip([
        { name: 'index.html', data: new Uint8Array(30 * 1024 * 1024), declaredSize: 100 },
        { name: 'ok.js', data: '1' },
      ]),
    );
    const r = await callRaw(owner, 'artifactPublish', { artifactId: id, uploadPath });
    expect([400, 413]).toContain(r.status);
    expect((await artifactDoc(id))!.currentBuild).toBe(null);
    expect(await stored(artifactPrefix.storageAll(id))).toEqual([]);
  });

  it('only reads a zip from THIS artifact’s uploads/, and wants exactly one source of files', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const other = await newArtifact(owner, 'Other');
    const elsewhere = await upload(other, makeZip(SITE));
    for (const uploadPath of [
      elsewhere,
      `artifacts/${id}/files/x.zip`,
      `artifacts/${id}/uploads/../../${other}/uploads/x.zip`,
      `artifacts/${id}/uploads/a/b.zip`,
      'boards/b/tickets/t/a/x.zip',
    ])
      await expect(
        call(owner, 'artifactPublish', { artifactId: id, uploadPath }),
      ).rejects.toMatchObject({ code: 'invalid' });
    // A refused path is never deleted: it was not ours to touch.
    expect((await bucket().file(elsewhere).exists())[0]).toBe(true);

    await expect(call(owner, 'artifactPublish', { artifactId: id })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      call(owner, 'artifactPublish', {
        artifactId: id,
        uploadPath: await upload(id, makeZip(SITE)),
        files: [{ path: 'index.html', content: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      call(owner, 'artifactPublish', {
        artifactId: id,
        uploadPath: artifactPrefix.storageUpload(id, 'never_uploaded'),
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('keeps the source zip beside the build, and hands out a link to it', async () => {
    const { owner, editor, id } = await scene();
    const source = makeZip([{ name: 'src/main.ts', data: 'export {}' }]);
    const first = await publish(owner, id, SITE, { source });
    expect((await buildDoc(id, first.buildId))!.sourcePath).toBe(
      artifactPrefix.storageSource(id, first.buildId),
    );
    const second = await publish(editor, id); // no source this time

    // The newest build WITH a source, not simply the newest build.
    const link = await call(editor, 'artifactSourceUrl', { artifactId: id });
    expect(link.buildId).toBe(first.buildId);
    const got = await request(pathOf(link.url));
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/zip');
    expect(got.headers.get('content-disposition')).toBe('attachment');
    expect(got.headers.get('content-security-policy')).toMatch(/^sandbox /);

    await expect(
      call(owner, 'artifactSourceUrl', { artifactId: id, buildId: second.buildId }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a new build on your artifact, published by somebody else, lands in your inbox', async () => {
    const { owner, editor, id } = await scene();
    await publish(editor, id);
    const row = (
      await db()
        .doc(paths.inboxItem(owner.uid, `artifact_${id}_build`))
        .get()
    ).data() as InboxItem;
    expect(row).toMatchObject({
      event: 'updated',
      artifactId: id,
      boardId: ARTIFACT_INVITE_BOARD_ID,
      actor: editor.uid,
      readAt: null,
    });
    expect(row.summary).toMatch(/Ed Editor published a new build/);
  });
});

describe('rolling back', () => {
  it('any kept build can be made current; an unknown one cannot', async () => {
    const { owner, editor, id } = await scene();
    const one = await publish(owner, id);
    const two = await publish(owner, id);
    expect((await artifactDoc(id))!.currentBuild).toBe(two.buildId);
    await call(editor, 'artifactSetCurrent', { artifactId: id, buildId: one.buildId });
    expect((await artifactDoc(id))!.currentBuild).toBe(one.buildId);
    await expect(
      call(owner, 'artifactSetCurrent', { artifactId: id, buildId: 'nosuchbuild0' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // Opening an older, kept build by name still works (a tab that was already open).
    await expect(
      call(owner, 'artifactOpen', { artifactId: id, buildId: two.buildId }),
    ).resolves.toMatchObject({ buildId: two.buildId });
    await expect(
      call(owner, 'artifactOpen', { artifactId: id, buildId: 'nosuchbuild0' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('artifactOpen and the /c file route (§D)', () => {
  it('nothing published yet is a 409, not a broken iframe', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    await expect(call(owner, 'artifactOpen', { artifactId: id })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('serves the build with the sandbox, cache and CORS headers — no session needed', async () => {
    const { owner, viewer, id } = await scene();
    const { buildId } = await publish(owner, id);
    const open = await call(viewer, 'artifactOpen', { artifactId: id });
    expect(open).toMatchObject({ buildId, role: 'viewer', readOnly: false });
    expect(open.contentUrl).toBe(`${open.contentBase}index.html`);
    expect(open.expiresAt - Date.now()).toBeGreaterThan(ARTIFACT_CAPABILITY_TTL_MS - 60_000);
    // The URL is on the usercontent origin — under the emulators, the functions emulator's api URL.
    expect(open.contentBase).toMatch(
      /^http:\/\/127\.0\.0\.1:5101\/demo-taskmanager\/us-central1\/api\/c\//,
    );

    const base = pathOf(open.contentBase);
    const index = await request(`${base}index.html`); // no Authorization header at all
    expect(index.status).toBe(200);
    expect(String(index.body)).toContain('<title>Hi</title>');
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('cache-control')).toBe('private, max-age=3600, immutable');
    expect(index.headers.get('x-content-type-options')).toBe('nosniff');
    expect(index.headers.get('content-security-policy')).toBe(
      'sandbox allow-scripts allow-forms allow-popups allow-downloads allow-modals',
    );
    expect(index.headers.get('access-control-allow-origin')).toBe('*');
    expect(index.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(index.headers.get('set-cookie')).toBe(null);

    // The build's own relative URLs resolve under the same prefix.
    const js = await request(`${base}assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(String(js.body)).toContain('document.title');
    const css = await request(`${base}assets/app.css`);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');

    // '' and '/' are index.html too.
    expect((await request(base)).status).toBe(200);
    expect(String((await request(base.replace(/\/$/, ''))).body)).toContain('<title>Hi</title>');
  });

  it('the URL it hands out RESOLVES: fetched for real from the functions emulator', async (t) => {
    // Under `pnpm test:emu` the functions emulator serves the built api beside
    // these in-process tests, on the same data. This is the dev setup itself:
    // the host page puts exactly this URL in the iframe.
    const owner = await createUser();
    const id = await newArtifact(owner);
    await publish(owner, id);
    const open = await call(owner, 'artifactOpen', { artifactId: id });
    const origin = new URL(open.contentUrl).origin;
    const up = await fetch(origin, { signal: AbortSignal.timeout(1500) }).then(
      () => true,
      () => false,
    );
    if (!up) return t.skip(); // emulators started without functions

    const index = await fetch(open.contentUrl);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<title>Hi</title>');
    expect(index.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(index.headers.get('cache-control')).toBe('private, max-age=3600, immutable');
    expect(index.headers.get('access-control-allow-origin')).toBe('*');
    // A relative asset URL, resolved the way the browser will.
    const js = await fetch(new URL('./assets/app.js', open.contentUrl));
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    // And a history-style deep link.
    const deep = await fetch(new URL('./settings/profile', open.contentBase));
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('<title>Hi</title>');
    expect((await fetch(new URL('./nope.js', open.contentBase))).status).toBe(404);
  });

  it('a deep link that is not a file falls back to index.html; a missing ASSET is a 404', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    await publish(owner, id);
    const base = pathOf((await call(owner, 'artifactOpen', { artifactId: id })).contentBase);

    for (const route of ['settings', 'a/b/c', 'assets/nope']) {
      const r = await request(base + route);
      expect(r.status, route).toBe(200);
      expect(String(r.body), route).toContain('<title>Hi</title>');
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    }
    for (const asset of ['assets/missing.js', 'favicon.ico', 'a/b/c.css']) {
      const r = await request(base + asset);
      expect(r.status, asset).toBe(404);
      // Even a 404 carries the sandbox: nothing on this origin is ever unsandboxed.
      expect(r.headers.get('content-security-policy')).toMatch(/^sandbox /);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('HEAD answers the headers without the body; other methods are not there', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    await publish(owner, id);
    const base = pathOf((await call(owner, 'artifactOpen', { artifactId: id })).contentBase);
    const head = await request(`${base}assets/app.js`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0);
    expect(head.body).toBe(null);
    expect((await request(`${base}index.html`, { method: 'POST' })).status).toBe(404);
    expect((await request(`${base}index.html`, { method: 'DELETE' })).status).toBe(404);
    const pre = await request(`${base}assets/app.js`, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('refuses a tampered capability, another artifact’s, a traversal — and nothing else is under /c', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const other = await newArtifact(owner, 'Other');
    await publish(owner, id);
    await publish(owner, other, [{ name: 'index.html', data: '<title>OTHER</title>' }]);
    const base = pathOf((await call(owner, 'artifactOpen', { artifactId: id })).contentBase);
    const cap = base.split('/')[2]!;
    const [body, sig] = cap.split('.') as [string, string];

    // Re-point the (unsigned) body at the other artifact: the signature no longer matches.
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(JSON.stringify({ ...payload, a: other })).toString('base64url');
    for (const bad of [
      `${forged}.${sig}`,
      `${body}.${sig.slice(0, -2)}xx`,
      body,
      'nonsense',
      `${body}.`,
    ]) {
      const r = await request(`/c/${bad}/index.html`);
      expect(r.status, bad).toBe(403);
      expect(r.headers.get('content-security-policy')).toMatch(/^sandbox /);
    }

    // A good capability cannot be walked out of its build.
    for (const path of [
      '../index.html',
      '..%2f..%2findex.html',
      '%2e%2e/%2e%2e/x.js',
      'a/..%5c..%5cb.js',
    ]) {
      const r = await request(`${base}${path}`);
      // 400 (a smuggled slash), 403 (the URL collapsed and the 'capability' is now a file name) or 404.
      expect([400, 403, 404], path).toContain(r.status);
      expect(String(r.body), path).not.toContain('OTHER');
    }
    // /c with no capability is nothing.
    expect((await request('/c')).status).toBe(404);
    expect((await request('/c/')).status).toBe(404);
  });

  inProcess('a capability stops working when it expires', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    await publish(owner, id);
    // Minted two hours ago: an hour past its end.
    setPorts({ clock: fixedClock(Date.now() - 2 * ARTIFACT_CAPABILITY_TTL_MS) });
    const stale = await call(owner, 'artifactOpen', { artifactId: id });
    const r = await request(pathOf(stale.contentUrl));
    expect(r.status).toBe(403);
    expect(String(r.body)).toMatch(/expired/);
  });

  it('a capability names ONE build: publishing does not change what an open tab loads', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    await publish(owner, id, [{ name: 'index.html', data: '<title>v1</title>' }]);
    const tab = await call(owner, 'artifactOpen', { artifactId: id });
    await publish(owner, id, [{ name: 'index.html', data: '<title>v2</title>' }]);
    expect(String((await request(pathOf(tab.contentUrl))).body)).toContain('v1');
    const fresh = await call(owner, 'artifactOpen', { artifactId: id });
    expect(String((await request(pathOf(fresh.contentUrl))).body)).toContain('v2');
  });
});

describe('the artifact’s uploaded files', () => {
  it('list, link (served sandboxed, with ranges) and delete — paths in the artifact’s own view', async () => {
    const { owner, viewer, stranger, id } = await scene();
    const put = (p: string, data: string, contentType: string) =>
      bucket()
        .file(artifactStorageFile(id, p))
        .save(Buffer.from(data), { contentType, resumable: false });
    await put('/pics/cat.png', 'PNGDATA', 'image/png');
    await put('/pics/dog.png', 'PNG2', 'image/png');
    await put('/notes/evil.html', '<script>alert(1)</script>', 'text/html');

    const all = await call(viewer, 'artifactFileList', { artifactId: id });
    expect(all.files.map((f) => f.path).sort()).toEqual([
      '/notes/evil.html',
      '/pics/cat.png',
      '/pics/dog.png',
    ]);
    expect(all.files.find((f) => f.path === '/pics/cat.png')).toMatchObject({
      size: 7,
      contentType: 'image/png',
      updatedAt: expect.any(Number),
    });
    const pics = await call(viewer, 'artifactFileList', { artifactId: id, path: '/pics' });
    expect(pics.files.map((f) => f.path).sort()).toEqual(['/pics/cat.png', '/pics/dog.png']);

    const link = await call(viewer, 'artifactFileUrl', { artifactId: id, path: 'pics/cat.png' });
    expect(link.expiresAt).toBeGreaterThan(Date.now());
    const got = await request(pathOf(link.url));
    expect(got.status).toBe(200);
    expect(got.body).toBe('PNGDATA');
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('content-security-policy')).toMatch(/^sandbox /);
    const part = await request(pathOf(link.url), { headers: { range: 'bytes=0-2' } });
    expect(part.status).toBe(206);
    expect(part.body).toBe('PNG');
    expect(part.headers.get('content-range')).toBe('bytes 0-2/7');

    // The link names its object: editing the visible file name reaches nothing else.
    const cap = pathOf(link.url).split('/')[2]!;
    expect((await request(`/c/${cap}/dog.png`)).body).toBe('PNGDATA');
    expect((await request(`/c/${cap}/../../notes/evil.html`)).body).not.toContain('alert');

    await expect(
      call(viewer, 'artifactFileUrl', { artifactId: id, path: '/pics/nope.png' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      call(viewer, 'artifactFileUrl', { artifactId: id, path: '/../../secrets' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(call(stranger, 'artifactFileList', { artifactId: id })).rejects.toMatchObject({
      code: 'not_found',
    });

    await call(owner, 'artifactFileDelete', { artifactId: id, path: '/pics/cat.png' });
    expect(
      (await call(owner, 'artifactFileList', { artifactId: id, path: 'pics' })).files.map(
        (f) => f.path,
      ),
    ).toEqual(['/pics/dog.png']);
  });
});

describe('artifactShare', () => {
  it('an account that exists gets the role at once, an inbox row, and the mirror follows', async () => {
    const owner = await createUser({ name: 'Olive' });
    const friend = await createUser({ name: 'Fran' });
    const id = await newArtifact(owner);
    await expect(
      call(owner, 'artifactShare', {
        artifactId: id,
        email: friend.email.toUpperCase(),
        role: 'viewer',
      }),
    ).resolves.toEqual({ ok: true, outcome: 'granted' });
    expect(await artifactDoc(id)).toMatchObject({
      access: { [owner.uid]: 'owner', [friend.uid]: 'viewer' },
      memberUids: [owner.uid, friend.uid].sort(),
    });
    expect((await mirror(id)).readers).toEqual({ [owner.uid]: 'owner', [friend.uid]: 'viewer' });
    const row = (
      await db()
        .doc(paths.inboxItem(friend.uid, `artifact_${id}`))
        .get()
    ).data() as InboxItem;
    expect(row).toMatchObject({
      event: 'invited',
      artifactId: id,
      actor: owner.uid,
      inviteId: null,
    });
    expect(row.summary).toBe('Olive shared the artifact “Sales dashboard” with you as a viewer');

    // Changing the role, then taking it away.
    await call(owner, 'artifactShare', { artifactId: id, email: friend.email, role: 'editor' });
    expect((await mirror(id)).readers![friend.uid]).toBe('editor');
    await expect(
      call(owner, 'artifactShare', { artifactId: id, email: friend.email, role: null }),
    ).resolves.toEqual({ ok: true, outcome: 'removed' });
    expect(await artifactDoc(id)).toMatchObject({
      access: { [owner.uid]: 'owner' },
      memberUids: [owner.uid],
    });
    expect((await mirror(id)).readers).toEqual({ [owner.uid]: 'owner' });
    await expect(call(friend, 'artifactOpen', { artifactId: id })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('the owner’s own role cannot be changed or removed', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    for (const role of ['viewer', 'editor', null] as const)
      await expect(
        call(owner, 'artifactShare', { artifactId: id, email: owner.email, role }),
      ).rejects.toMatchObject({ code: 'conflict' });
    expect((await artifactDoc(id))!.access).toEqual({ [owner.uid]: 'owner' });
  });

  it('an account the admin has not allowed can never be given a role (§X)', async () => {
    const owner = await createUser();
    const blocked = await createUser();
    await db().doc(paths.user(blocked.uid)).set({ allowed: false }, { merge: true });
    const id = await newArtifact(owner);
    await expect(
      call(owner, 'artifactShare', { artifactId: id, email: blocked.email, role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'notAllowed' } });
    expect((await artifactDoc(id))!.access).toEqual({ [owner.uid]: 'owner' });
  });

  it('needs exactly one of email / agentId', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    await expect(
      call(owner, 'artifactShare', { artifactId: id, role: 'viewer' }),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      call(owner, 'artifactShare', {
        artifactId: id,
        email: 'a@b.dev',
        agentId: 'ag_0123456789abcdef',
        role: 'viewer',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  // §AA3 CHANGED THIS TEST. It used to say "always an editor": whatever role
  // was asked, the agent was stored as 'editor'. An agent now has { build,
  // data }; the old role form still works ('editor' → both, null → removed),
  // and a 'viewer' role for an agent is refused instead of silently coerced.
  it('an agent: one of the OWNER’s; the old role form still works; removable', async () => {
    const owner = await createUser();
    const someoneElse = await createUser();
    const mine = await seedAgent(owner);
    const theirs = await seedAgent(someoneElse);
    const id = await newArtifact(owner);

    // There is no 'viewer' for an agent — say what it may do with agentAccess.
    await expect(
      call(owner, 'artifactShare', { artifactId: id, agentId: mine.id, role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect((await artifactDoc(id))!.agents).toEqual({});
    // The old form: 'editor' is both permissions, stored as the object.
    await expect(
      call(owner, 'artifactShare', { artifactId: id, agentId: mine.id, role: 'editor' }),
    ).resolves.toEqual({ ok: true, outcome: 'granted' });
    expect((await artifactDoc(id))!.agents).toEqual({ [mine.id]: { build: true, data: 'write' } });
    // Agents are never people: not in access, not in memberUids, not in the RTDB mirror.
    expect((await artifactDoc(id))!.memberUids).toEqual([owner.uid]);
    expect((await mirror(id)).readers).toEqual({ [owner.uid]: 'owner' });

    await expect(
      call(owner, 'artifactShare', { artifactId: id, agentId: theirs.id, role: 'editor' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      call(owner, 'artifactShare', {
        artifactId: id,
        agentId: 'ag_0000000000000000',
        role: 'editor',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    await expect(
      call(owner, 'artifactShare', { artifactId: id, agentId: mine.id, role: null }),
    ).resolves.toEqual({ ok: true, outcome: 'removed' });
    expect((await artifactDoc(id))!.agents).toEqual({});
  });
});

describe('share → invite → accept', () => {
  const invitesFor = async (artifactId: string) =>
    (await db().collection(paths.invites()).where('artifactId', '==', artifactId).get()).docs.map(
      (d) => ({ id: d.id, ...(d.data() as Invite) }),
    );
  const lastLink = async (addr: string) => {
    const mail = await devOutbox<{ text: string; subject: string }>('mail', {
      field: 'to',
      equals: addr,
    });
    const last = mail[mail.length - 1]!;
    const m = /\/invite\/([^.\s]+)\.(\S+)/.exec(last.text)!;
    return { inviteId: m[1]!, token: m[2]!, subject: last.subject, text: last.text };
  };

  it('an address with no account is invited; signing up and accepting gives the role', async () => {
    const owner = await createUser({ name: 'Olive' });
    const id = await newArtifact(owner);
    const addr = `newbie.${uniq()}@test.dev`;

    await expect(
      call(owner, 'artifactShare', { artifactId: id, email: addr, role: 'editor' }),
    ).resolves.toEqual({ ok: true, outcome: 'invited' });
    const [inv] = await invitesFor(id);
    expect(inv).toMatchObject({
      artifactId: id,
      boardId: ARTIFACT_INVITE_BOARD_ID,
      boardName: 'Sales dashboard',
      email: addr,
      role: 'editor',
      invitedBy: owner.uid,
      status: 'pending',
    });
    // Nobody has a role yet.
    expect((await artifactDoc(id))!.memberUids).toEqual([owner.uid]);
    const link = await lastLink(addr);
    expect(link.inviteId).toBe(inv!.id);
    expect(link.subject).toBe('Olive shared “Sales dashboard” with you');
    expect(link.text).toContain('shared the artifact “Sales dashboard” with you as an editor');

    // Sharing again refreshes the SAME invite (new token, new role) — no duplicate.
    await call(owner, 'artifactShare', { artifactId: id, email: addr, role: 'viewer' });
    expect(await invitesFor(id)).toHaveLength(1);
    const fresh = await lastLink(addr);
    expect(fresh.inviteId).toBe(inv!.id);
    expect(fresh.token).not.toBe(link.token);

    // They sign up with that address and accept from the link.
    const newbie = await createUser({ email: addr, name: 'Nia' });
    await expect(
      call(newbie, 'inviteAccept', { inviteId: inv!.id, token: link.token, accept: true }),
    ).rejects.toMatchObject({ code: 'not_found' }); // the old link died with the refresh
    const res = await call(newbie, 'inviteAccept', {
      inviteId: inv!.id,
      token: fresh.token,
      accept: true,
    });
    expect(res).toMatchObject({ artifactId: id, boardId: ARTIFACT_INVITE_BOARD_ID });

    expect(await artifactDoc(id)).toMatchObject({
      access: { [owner.uid]: 'owner', [newbie.uid]: 'viewer' },
      memberUids: [owner.uid, newbie.uid].sort(),
    });
    expect((await mirror(id)).readers![newbie.uid]).toBe('viewer');
    expect((await invitesFor(id))[0]!.status).toBe('accepted');
    await expect(call(newbie, 'artifactOpen', { artifactId: id })).rejects.toMatchObject({
      code: 'conflict', // they are in; there is just no build yet
    });
    // The owner is told.
    const told = (
      await db()
        .doc(paths.inboxItem(owner.uid, `artifact_${id}_joined_${newbie.uid}`))
        .get()
    ).data() as InboxItem;
    expect(told.summary).toBe('Nia now has access to “Sales dashboard”');
    // Used once.
    await expect(
      call(newbie, 'inviteAccept', { inviteId: inv!.id, accept: true }),
    ).rejects.toMatchObject({ code: 'gone' });
  });

  it('only the invited address may accept; declining gives nothing', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const addr = `newbie.${uniq()}@test.dev`;
    await call(owner, 'artifactShare', { artifactId: id, email: addr, role: 'viewer' });
    const { inviteId, token } = await lastLink(addr);

    const thief = await createUser();
    await expect(
      call(thief, 'inviteAccept', { inviteId, token, accept: true }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const newbie = await createUser({ email: addr });
    await call(newbie, 'inviteAccept', { inviteId, token, accept: false });
    expect((await artifactDoc(id))!.access).toEqual({ [owner.uid]: 'owner' });
    expect((await invitesFor(id))[0]!.status).toBe('declined');
  });

  it('removing the address, or revoking the invite, withdraws it; a stranger cannot revoke', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const id = await newArtifact(owner);
    const a = `a.${uniq()}@test.dev`;
    const b = `b.${uniq()}@test.dev`;
    await call(owner, 'artifactShare', { artifactId: id, email: a, role: 'viewer' });
    await call(owner, 'artifactShare', { artifactId: id, email: b, role: 'viewer' });
    const byEmail = async () => Object.fromEntries((await invitesFor(id)).map((i) => [i.email, i]));

    await expect(
      call(owner, 'artifactShare', { artifactId: id, email: a, role: null }),
    ).resolves.toEqual({ ok: true, outcome: 'removed' });
    expect((await byEmail())[a]!.status).toBe('revoked');

    const invB = (await byEmail())[b]!;
    await expect(call(stranger, 'inviteRevoke', { inviteId: invB.id })).rejects.toMatchObject({
      code: 'not_found',
    });
    await call(owner, 'inviteRevoke', { inviteId: invB.id });
    expect((await byEmail())[b]!.status).toBe('revoked');
    const late = await createUser({ email: b });
    await expect(
      call(late, 'inviteAccept', { inviteId: invB.id, accept: true }),
    ).rejects.toMatchObject({ code: 'gone' });
  });

  it('someone who signs up BEFORE the owner shares again is simply granted; the old invite is settled', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const addr = `early.${uniq()}@test.dev`;
    await call(owner, 'artifactShare', { artifactId: id, email: addr, role: 'viewer' });
    const early = await createUser({ email: addr });
    await expect(
      call(owner, 'artifactShare', { artifactId: id, email: addr, role: 'editor' }),
    ).resolves.toEqual({ ok: true, outcome: 'granted' });
    expect((await artifactDoc(id))!.access[early.uid]).toBe('editor');
    expect((await invitesFor(id))[0]!.status).toBe('accepted');
  });
});

describe('the delete queue', () => {
  /** Give an artifact one of everything it can own. */
  async function furnish(owner: TestUser, viewer: TestUser, id: string) {
    const { buildId } = await publish(owner, id, SITE, {
      source: makeZip([{ name: 'a.ts', data: '1' }]),
    });
    await db().doc(artifactFirestoreDoc(id, '/my/doc')).set({ n: 1 });
    await db().doc(artifactFirestoreDoc(id, '/my/doc/items/deep')).set({ n: 2 });
    await db()
      .doc(artifactKvDoc(id, viewer.uid, 'theme'))
      .set({ value: 'dark', updatedAt: 1 });
    await rtdbAdmin().ref(artifactRtdbPath(id, '/counter')).set(7);
    await bucket()
      .file(artifactStorageFile(id, '/pics/cat.png'))
      .save(Buffer.from('png'), { resumable: false });
    await upload(id, makeZip(SITE)); // a zip that was never published
    return buildId;
  }
  const dataLeft = async (id: string) => ({
    doc: (await db().doc(artifactFirestoreDoc(id, '/my/doc')).get()).exists,
    deep: (await db().doc(artifactFirestoreDoc(id, '/my/doc/items/deep')).get()).exists,
    rtdb: (await rtdbAdmin().ref(artifactPrefix.rtdb(id)).get()).exists(),
    files: (await stored(`${artifactPrefix.storageFiles(id)}/`)).length,
  });

  inProcess(
    'artifactDelete: gone for everyone at once, then everything is removed, the document last',
    async () => {
      const { owner, editor, viewer, id } = await scene();
      const addr = `pending.${uniq()}@test.dev`;
      await call(owner, 'artifactShare', { artifactId: id, email: addr, role: 'viewer' });
      await furnish(owner, viewer, id);

      await expect(call(owner, 'artifactDelete', { artifactId: id })).resolves.toEqual({
        ok: true,
      });

      // Before the job runs: the document is still there, but nobody can reach it.
      expect(await artifactDoc(id)).toMatchObject({
        access: {},
        memberUids: [],
        agents: {},
        deletingAt: expect.any(Number),
        archivedAt: expect.any(Number),
      });
      expect(await mirror(id)).toEqual({ readers: null, flags: null });
      for (const who of [owner, editor, viewer])
        await expect(call(who, 'artifactOpen', { artifactId: id })).rejects.toMatchObject({
          code: 'not_found',
        });
      expect(
        queue()
          .pending()
          .map((t) => t.queue),
      ).toContain('artifactDelete');

      await queue().drain({ queue: 'artifactDelete' });

      expect(await artifactDoc(id)).toBeUndefined();
      expect((await db().collection(`artifacts/${id}/builds`).get()).size).toBe(0);
      expect(
        (
          await db()
            .doc(artifactKvDoc(id, viewer.uid, 'theme'))
            .get()
        ).exists,
      ).toBe(false);
      expect(await dataLeft(id)).toEqual({ doc: false, deep: false, rtdb: false, files: 0 });
      expect(await stored(artifactPrefix.storageAll(id))).toEqual([]); // builds, source, uploads, files
      const pending = await db().collection(paths.invites()).where('artifactId', '==', id).get();
      expect(pending.docs.map((d) => d.get('status'))).toEqual(['revoked']);

      // The job is idempotent (Cloud Tasks retries).
      const { purgeArtifact } = await import('../../src/artifacts/purge.js');
      await expect(purgeArtifact(id)).resolves.toBeUndefined();
    },
  );

  inProcess('artifactDataClear: the data goes; builds, people and the document stay', async () => {
    const { owner, viewer, id } = await scene();
    const buildId = await furnish(owner, viewer, id);

    await call(owner, 'artifactDataClear', { artifactId: id });
    expect((await dataLeft(id)).doc).toBe(true); // queued, not done inline
    await queue().drain({ queue: 'artifactDelete' });

    expect(await dataLeft(id)).toEqual({ doc: false, deep: false, rtdb: false, files: 0 });
    expect(
      (
        await db()
          .doc(artifactKvDoc(id, viewer.uid, 'theme'))
          .get()
      ).exists,
    ).toBe(false);
    expect(await artifactDoc(id)).toMatchObject({
      currentBuild: buildId,
      memberUids: expect.any(Array),
    });
    expect((await artifactDoc(id))!.memberUids).toHaveLength(3);
    expect(await buildDoc(id, buildId)).toBeDefined();
    expect((await stored(`${artifactPrefix.storageBuild(id, buildId)}/`)).length).toBe(3);
    expect((await bucket().file(artifactPrefix.storageSource(id, buildId)).exists())[0]).toBe(true);
    expect((await mirror(id)).readers).not.toBe(null);
    // And it still opens.
    await expect(call(viewer, 'artifactOpen', { artifactId: id })).resolves.toMatchObject({
      buildId,
    });
  });
});

describe('housekeeping', () => {
  inProcess(
    'keeps the newest ten builds and the current one; sweeps day-old upload zips; heals the mirror',
    async () => {
      const owner = await createUser();
      const id = await newArtifact(owner);
      const builds: string[] = [];
      let t = Date.now() - 1_000_000;
      for (let i = 0; i < ARTIFACT_BUILDS_KEPT + 3; i++) {
        setPorts({ clock: fixedClock((t += 1000)) });
        const r = await call(owner, 'artifactPublish', {
          artifactId: id,
          files: [{ path: 'index.html', content: `<title>v${i}</title>` }],
        });
        builds.push(r.buildId);
      }
      // Roll back to the OLDEST build: it is beyond the newest ten and must survive.
      await call(owner, 'artifactSetCurrent', { artifactId: id, buildId: builds[0]! });
      const stale = await upload(id, makeZip(SITE));
      await rtdbAdmin().ref(artifactPrefix.rtdbReaders(id)).remove(); // a mirror write that was lost

      // "Tomorrow": the upload is now more than a day old.
      const res = await artifactHousekeeping(Date.now() + ARTIFACT_UPLOAD_TTL_MS + 60_000);
      expect(res.buildsPruned).toBeGreaterThanOrEqual(2);
      expect(res.uploadsDeleted).toBeGreaterThanOrEqual(1);

      const left = (await db().collection(`artifacts/${id}/builds`).get()).docs.map((d) => d.id);
      expect(left.sort()).toEqual([builds[0]!, ...builds.slice(3)].sort());
      for (const gone of builds.slice(1, 3))
        expect(await stored(`${artifactPrefix.storageBuild(id, gone)}/`)).toEqual([]);
      expect((await stored(`${artifactPrefix.storageBuild(id, builds[0]!)}/`)).length).toBe(1);
      expect((await bucket().file(stale).exists())[0]).toBe(false);
      expect((await mirror(id)).readers).toEqual({ [owner.uid]: 'owner' });

      // A fresh upload is left alone.
      const fresh = await upload(id, makeZip(SITE));
      await artifactHousekeeping(Date.now());
      expect((await bucket().file(fresh).exists())[0]).toBe(true);
    },
  );
});

describe('REST /v1/artifacts with an ACCOUNT token (§C1, §C4)', () => {
  const WRITE: Scope[] = ['artifacts:read', 'artifacts:write'];

  it('create → publish a zip → get → roll back → source → share → delete', async () => {
    const owner = await createUser({ name: 'Olive' });
    const friend = await createUser({ name: 'Fran' });
    const { key } = await accountKeyFor(owner, WRITE);

    const created = await rest(key, 'POST', '/v1/artifacts', {
      name: 'Sales dashboard',
      description: 'Weekly',
    });
    expect(created.status).toBe(201);
    const art = created.body as PublicArtifact;
    expect(art).toMatchObject({
      name: 'Sales dashboard',
      description: 'Weekly',
      role: 'owner',
      read_only: false,
      archived: false,
      current_build: null,
      owner_id: owner.uid,
    });
    expect(art.url).toMatch(new RegExp(`/x/${art.id}$`));
    expect(created.headers.get('location')).toBe(`/v1/artifacts/${art.id}`);

    // The body IS the zip.
    const pub = await request(`/v1/artifacts/${art.id}/builds?message=first%20cut`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/zip' },
      body: makeZip(SITE),
    });
    expect(pub.status).toBe(201);
    const b1 = pub.body as PublicArtifactBuild;
    expect(b1).toMatchObject({
      files: 3,
      message: 'first cut',
      warnings: [],
      has_source: false,
      current: true,
      by: { id: owner.uid, kind: 'user', name: 'Olive' },
    });
    expect(await stored(artifactPrefix.storageUploads(art.id))).toEqual([]);

    // Multipart: a build and its source.
    const form = new FormData();
    form.set('build', new Blob([makeZip(SITE)], { type: 'application/zip' }), 'dist.zip');
    form.set('source', new Blob([makeZip([{ name: 'src/main.ts', data: 'x' }])]), 'src.zip');
    const pub2 = await request(`/v1/artifacts/${art.id}/builds?source=1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    expect(pub2.status).toBe(201);
    const b2 = pub2.body as PublicArtifactBuild;
    expect(b2).toMatchObject({ has_source: true, current: true });

    const list = await rest(key, 'GET', '/v1/artifacts');
    expect((list.body as { data: PublicArtifact[] }).data.map((a) => a.id)).toContain(art.id);

    const detail = (await rest(key, 'GET', `/v1/artifacts/${art.id}`)).body as PublicArtifactDetail;
    expect(detail.current_build).toBe(b2.id);
    expect(detail.builds.map((b) => [b.id, b.current])).toEqual([
      [b2.id, true],
      [b1.id, false],
    ]);
    expect(detail.members).toEqual([
      { id: owner.uid, kind: 'user', name: 'Olive', email: owner.email, role: 'owner' },
    ]);

    const back = await rest(key, 'POST', `/v1/artifacts/${art.id}/builds/${b1.id}/current`);
    expect(back.status).toBe(200);
    expect((back.body as PublicArtifact).current_build).toBe(b1.id);

    const src = await rest(key, 'GET', `/v1/artifacts/${art.id}/source`);
    expect(src.status).toBe(200);
    expect(src.body).toMatchObject({ build: b2.id, url: expect.stringContaining('/c/') });
    expect((await request(pathOf((src.body as { url: string }).url))).status).toBe(200);

    const share = await rest(key, 'PUT', `/v1/artifacts/${art.id}/access`, {
      email: friend.email,
      role: 'editor',
    });
    expect(share.body).toEqual({ ok: true, outcome: 'granted' });
    const patched = await rest(key, 'PATCH', `/v1/artifacts/${art.id}`, {
      read_only: true,
      name: 'Numbers',
    });
    expect(patched.body).toMatchObject({ name: 'Numbers', read_only: true });

    const del = await rest(key, 'DELETE', `/v1/artifacts/${art.id}`);
    expect(del.status).toBe(204);
    expect((await rest(key, 'GET', `/v1/artifacts/${art.id}`)).status).toBe(404);
  });

  it('reaches what its person owns or edits — never what they only view, never a stranger’s', async () => {
    const { editor, viewer, stranger, id } = await scene();
    const asEditor = (await accountKeyFor(editor, WRITE)).key;
    const asViewer = (await accountKeyFor(viewer, WRITE)).key;
    const asStranger = (await accountKeyFor(stranger, WRITE)).key;
    const ids = async (key: string) =>
      ((await rest(key, 'GET', '/v1/artifacts')).body as { data: PublicArtifact[] }).data.map(
        (a) => a.id,
      );

    expect(await ids(asEditor)).toContain(id);
    expect(await ids(asViewer)).not.toContain(id);
    expect(await ids(asStranger)).not.toContain(id);
    expect((await rest(asEditor, 'GET', `/v1/artifacts/${id}`)).body).toMatchObject({
      role: 'editor',
    });
    expect((await rest(asViewer, 'GET', `/v1/artifacts/${id}`)).status).toBe(404);
    expect((await rest(asStranger, 'GET', `/v1/artifacts/${id}`)).status).toBe(404);
    // An editor's token publishes but does not share or delete.
    const pub = await request(`/v1/artifacts/${id}/builds`, {
      method: 'POST',
      headers: { authorization: `Bearer ${asEditor}`, 'content-type': 'application/zip' },
      body: makeZip(SITE),
    });
    expect(pub.status).toBe(201);
    expect(
      (
        await rest(asEditor, 'PUT', `/v1/artifacts/${id}/access`, {
          email: 'x@y.dev',
          role: 'viewer',
        })
      ).status,
    ).toBe(403);
    expect((await rest(asEditor, 'DELETE', `/v1/artifacts/${id}`)).status).toBe(403);
  });

  it('scopes gate: read lists and gets, write is needed to change anything', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const read = (await accountKeyFor(owner, ['artifacts:read'])).key;
    const none = (await accountKeyFor(owner, ['board:read'])).key;

    expect((await rest(read, 'GET', '/v1/artifacts')).status).toBe(200);
    expect((await rest(read, 'GET', `/v1/artifacts/${id}`)).status).toBe(200);
    expect((await rest(read, 'POST', '/v1/artifacts', { name: 'x' })).status).toBe(403);
    expect((await rest(read, 'PATCH', `/v1/artifacts/${id}`, { name: 'x' })).status).toBe(403);
    expect((await rest(read, 'DELETE', `/v1/artifacts/${id}`)).status).toBe(403);
    const pub = await request(`/v1/artifacts/${id}/builds`, {
      method: 'POST',
      headers: { authorization: `Bearer ${read}`, 'content-type': 'application/zip' },
      body: makeZip(SITE),
    });
    expect(pub.status).toBe(403);
    expect((await rest(none, 'GET', '/v1/artifacts')).status).toBe(403);
    expect((await rest(null, 'GET', '/v1/artifacts')).status).toBe(401);
  });

  it('a bad zip over REST is a problem+json, and leaves no upload behind', async () => {
    const owner = await createUser();
    const id = await newArtifact(owner);
    const { key } = await accountKeyFor(owner, WRITE);
    const post = (body: string | Buffer, headers: Record<string, string> = {}) =>
      request(`/v1/artifacts/${id}/builds`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/zip', ...headers },
        body,
      });

    const junk = await post(Buffer.from('not a zip at all'));
    expect(junk.status).toBe(400);
    expect(junk.headers.get('content-type')).toContain('application/problem+json');
    expect((await post(Buffer.alloc(0))).status).toBe(400);
    expect((await post(makeZip([{ name: '../x.html', data: '1' }, ...SITE]))).status).toBe(400);
    // Refused from the Content-Length, before the body is read.
    expect((await post('x', { 'content-length': String(40 * 1024 * 1024) })).status).toBe(413);
    expect(await stored(artifactPrefix.storageAll(id))).toEqual([]);
  });

  it('the OpenAPI document describes the artifact routes', async () => {
    const doc = (await request('/v1/openapi.json')).body as {
      paths: Record<string, Record<string, { requestBody?: { content: Record<string, unknown> } }>>;
      components: { schemas: Record<string, unknown> };
    };
    for (const p of [
      '/v1/artifacts',
      '/v1/artifacts/{id}',
      '/v1/artifacts/{id}/builds',
      '/v1/artifacts/{id}/builds/{build}/current',
      '/v1/artifacts/{id}/source',
      '/v1/artifacts/{id}/access',
    ])
      expect(doc.paths[p], p).toBeDefined();
    expect(Object.keys(doc.paths['/v1/artifacts/{id}/builds']!.post!.requestBody!.content)).toEqual(
      ['application/zip', 'multipart/form-data'],
    );
    expect(doc.components.schemas.ArtifactDetail).toBeDefined();
  });
});

describe('an AGENT token (§C4)', () => {
  it('reaches only the artifacts the agent is on, publishes there, and never shares or deletes', async () => {
    const owner = await createUser({ name: 'Olive' });
    const { boardId } = await newBoard(owner);
    const agent = await seedAgent(owner, { boardId, name: 'Builder' });
    const { key } = await agentKeyFor(
      owner,
      agent.id,
      ['artifacts:read', 'artifacts:write'],
      boardId,
    );
    const on = await newArtifact(owner, 'Agent is on this');
    const off = await newArtifact(owner, 'Agent is not on this');

    // Owned by its owner — and still invisible until the agent is added.
    const ids = async () =>
      ((await rest(key, 'GET', '/v1/artifacts')).body as { data: PublicArtifact[] }).data.map(
        (a) => a.id,
      );
    expect(await ids()).toEqual([]);
    expect((await rest(key, 'GET', `/v1/artifacts/${on}`)).status).toBe(404);

    await call(owner, 'artifactShare', { artifactId: on, agentId: agent.id, role: 'editor' });
    expect(await ids()).toEqual([on]);
    expect((await rest(key, 'GET', `/v1/artifacts/${on}`)).body).toMatchObject({ role: 'editor' });
    expect((await rest(key, 'GET', `/v1/artifacts/${off}`)).status).toBe(404);

    const pub = await request(`/v1/artifacts/${on}/builds?message=by%20agent`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/zip' },
      body: makeZip(SITE),
    });
    expect(pub.status).toBe(201);
    expect(pub.body).toMatchObject({ by: { id: agent.id, kind: 'agent', name: 'Builder' } });
    const off2 = await request(`/v1/artifacts/${off}/builds`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/zip' },
      body: makeZip(SITE),
    });
    expect(off2.status).toBe(404);
    expect(await stored(artifactPrefix.storageAll(off))).toEqual([]);

    // An editor, never an owner: no sharing, no deleting.
    expect(
      (await rest(key, 'PUT', `/v1/artifacts/${on}/access`, { email: 'x@y.dev', role: 'viewer' }))
        .status,
    ).toBe(403);
    expect((await rest(key, 'DELETE', `/v1/artifacts/${on}`)).status).toBe(403);

    // Taken off again: gone on the next call.
    await call(owner, 'artifactShare', { artifactId: on, agentId: agent.id, role: null });
    expect(await ids()).toEqual([]);
    expect((await rest(key, 'GET', `/v1/artifacts/${on}`)).status).toBe(404);
  });
});

describe('MCP (§C2)', () => {
  it('lists the artifact tools by scope, and publishes from files', async () => {
    const owner = await createUser({ name: 'Olive' });
    const { key } = await accountKeyFor(owner, ['artifacts:read', 'artifacts:write']);
    const client = await mcpClient(key);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of [
      'artifact_list',
      'artifact_get',
      'artifact_create',
      'artifact_publish',
      'artifact_rollback',
      'artifact_share',
      'artifact_source',
    ])
      expect(tools).toContain(t);

    const art = parsed<PublicArtifact>(
      await client.callTool({ name: 'artifact_create', arguments: { name: 'Poll' } }),
    );
    expect(art).toMatchObject({ name: 'Poll', role: 'owner', current_build: null });

    const b1 = parsed<PublicArtifactBuild & { url: string }>(
      await client.callTool({
        name: 'artifact_publish',
        arguments: {
          id: art.id,
          message: 'v1',
          files: [
            { path: 'index.html', content: '<script src="./app.js"></script>' },
            { path: 'app.js', content: 'console.log(1)' },
          ],
        },
      }),
    );
    expect(b1).toMatchObject({ files: 2, message: 'v1', current: true, warnings: [] });
    expect(b1.url).toMatch(new RegExp(`/x/${art.id}$`));
    const b2 = parsed<PublicArtifactBuild>(
      await client.callTool({
        name: 'artifact_publish',
        arguments: { id: art.id, files: [{ path: 'index.html', content: 'v2' }] },
      }),
    );

    expect(
      parsed<PublicArtifact[]>(await client.callTool({ name: 'artifact_list', arguments: {} })).map(
        (a) => a.id,
      ),
    ).toContain(art.id);
    const rolled = parsed<PublicArtifact>(
      await client.callTool({ name: 'artifact_rollback', arguments: { id: art.id, build: b1.id } }),
    );
    expect(rolled.current_build).toBe(b1.id);
    const detail = parsed<PublicArtifactDetail>(
      await client.callTool({ name: 'artifact_get', arguments: { id: art.id } }),
    );
    expect(detail.builds.map((b) => b.id)).toEqual([b2.id, b1.id]);

    const friend = await createUser();
    expect(
      parsed(
        await client.callTool({
          name: 'artifact_share',
          arguments: { id: art.id, email: friend.email, role: 'viewer' },
        }),
      ),
    ).toEqual({ ok: true, outcome: 'granted' });
    // Errors come back as tool errors, in words.
    expect(
      toolError(await client.callTool({ name: 'artifact_source', arguments: { id: art.id } })),
    ).toMatch(/not_found/);
    expect(
      toolError(
        await client.callTool({
          name: 'artifact_publish',
          arguments: { id: art.id, files: [{ path: '../x.html', content: 'x' }] },
        }),
      ),
    ).toMatch(/invalid/);
    await client.close();

    // A credential without the scopes never sees the tools.
    const plain = await mcpClient((await accountKeyFor(owner, ['board:read'])).key);
    expect(
      (await plain.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('artifact_')),
    ).toEqual([]);
    await plain.close();
  });
});

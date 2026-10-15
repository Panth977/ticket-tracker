/**
 * BUCKET (docs/plan/bucket.html) — the commands, end to end on the emulators:
 *
 *   §B   roles: owner manages, editor writes, viewer reads, a stranger gets 404
 *   §A   paths: parents created, unique paths, folder moves take their subtree,
 *        recursive delete, the counters follow
 *   D-M2 a new version is a new object; the old one is deleted; stale saves 409
 *   §D   grants: a board's members read, its editors (people and agents) write
 *   §E   tickets point at a node; the file door resolves the CURRENT version,
 *        and stops when the grant goes
 *   §G   delete: unreachable at once, then the job removes everything
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_TOKEN_SCOPES,
  bucketStoragePath,
  paths,
  type Bucket,
  type BucketNode,
} from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { storageBucket } from '../../src/blob/index.js';
import { asAgent, makeAgent } from '../agents/helpers.js';
import { call, queue, request, setupEmulators, uniq, type TestUser } from '../harness/index.js';
import { doc, people, seedBoard } from '../tickets/helpers.js';

setupEmulators();

const inProcess = it.skipIf(!!process.env.TM_API_URL);
const bucket = () => storageBucket();
const stored = async (prefix: string) =>
  (await bucket().getFiles({ prefix }))[0].map((f) => f.name).sort();
const memDoc = async (id: string) =>
  (await db().doc(paths.bucket(id)).get()).data() as Bucket | undefined;
const nodes = async (id: string) =>
  (await db().collection(paths.bucketNodes(id)).get()).docs
    .map((d) => ({ id: d.id, ...(d.data() as BucketNode) }))
    .sort((a, b) => a.path.localeCompare(b.path));

async function newBucket(owner: TestUser, name = 'Brand kit'): Promise<string> {
  return (await call(owner, 'bucketCreate', { name })).bucketId;
}
const write = (u: TestUser, bucketId: string, path: string, text: string, extra: object = {}) =>
  call(u, 'bucketFileWrite', { bucketId, path, text, ...extra });

const fileUrl = (u: TestUser, path: string) =>
  request(`/api/files/url?path=${encodeURIComponent(path)}`, {
    headers: { authorization: `Bearer ${u.token}` },
  });

describe('bucket: people (§B)', () => {
  it('owner manages, editor writes, viewer reads, a stranger finds nothing', async () => {
    const { owner, ed, view, stranger } = await people('owner', 'ed', 'view', 'stranger');
    const bucketId = await newBucket(owner);
    await call(owner, 'bucketShare', { bucketId, email: ed.email, role: 'editor' });
    await call(owner, 'bucketShare', { bucketId, email: view.email, role: 'viewer' });
    expect((await memDoc(bucketId))!.memberUids).toEqual([owner.uid, ed.uid, view.uid].sort());

    await write(ed, bucketId, 'notes/hello.md', '# Hello');
    const read = await call(view, 'bucketFileRead', { bucketId, path: 'notes/hello.md' });
    expect(read.text).toBe('# Hello');
    expect(read.node).toMatchObject({ kind: 'file', name: 'hello.md', path: 'notes/hello.md' });
    expect(read.url).toBeTruthy();

    await expect(write(view, bucketId, 'x.md', 'no')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(ed, 'bucketShare', { bucketId, email: stranger.email, role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(call(stranger, 'bucketTree', { bucketId })).rejects.toMatchObject({
      code: 'not_found',
    });
    // An unknown address is not invited (yet): it says so.
    await expect(
      call(owner, 'bucketShare', { bucketId, email: `${uniq('nobody')}@test.dev`, role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // Taking the role away takes the reach away.
    await call(owner, 'bucketShare', { bucketId, email: view.email, role: null });
    await expect(call(view, 'bucketTree', { bucketId })).rejects.toMatchObject({
      code: 'not_found',
    });

    const list = await call(ed, 'bucketList', {});
    expect(list.buckets.map((m) => [m.id, m.reach])).toEqual([[bucketId, 'write']]);
  });

  it('archived: read-only until the owner restores it', async () => {
    const { owner } = await people('owner');
    const bucketId = await newBucket(owner);
    await call(owner, 'bucketUpdate', { bucketId, archived: true, name: 'Old kit' });
    await expect(write(owner, bucketId, 'a.md', 'x')).rejects.toMatchObject({ code: 'conflict' });
    expect((await call(owner, 'bucketList', {})).buckets).toEqual([]);
    expect((await call(owner, 'bucketList', { includeArchived: true })).buckets[0]).toMatchObject({
      name: 'Old kit',
      archived: true,
    });
    await call(owner, 'bucketUpdate', { bucketId, archived: false });
    await write(owner, bucketId, 'a.md', 'x');
  });
});

describe('bucket: paths (§A)', () => {
  it('parents are created; a file in the way and a taken path are refused', async () => {
    const { owner } = await people('owner');
    const bucketId = await newBucket(owner);
    await write(owner, bucketId, '/docs//brand/ logo.svg ', '<svg/>');
    expect((await nodes(bucketId)).map((n) => [n.path, n.kind])).toEqual([
      ['docs', 'folder'],
      ['docs/brand', 'folder'],
      ['docs/brand/logo.svg', 'file'],
    ]);
    const tree = await call(owner, 'bucketTree', { bucketId, path: 'docs', shallow: true });
    expect(tree.nodes.map((n) => n.path)).toEqual(['docs/brand']);
    expect((await memDoc(bucketId))!.stats).toEqual({ files: 1, folders: 2, bytes: 6 });

    // mkdir -p: an existing folder is fine, a file in the way is not.
    const again = await call(owner, 'bucketFolderCreate', { bucketId, path: 'docs/brand' });
    expect(again.path).toBe('docs/brand');
    await expect(
      call(owner, 'bucketFolderCreate', { bucketId, path: 'docs/brand/logo.svg/x' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(write(owner, bucketId, 'docs', 'x')).rejects.toMatchObject({ code: 'conflict' });
    await expect(write(owner, bucketId, 'a/../b', 'x')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a folder move takes its subtree; moving inside itself or onto something is refused', async () => {
    const { owner } = await people('owner');
    const bucketId = await newBucket(owner);
    await write(owner, bucketId, 'a/one.md', '1');
    await write(owner, bucketId, 'a/b/two.md', '2');
    await write(owner, bucketId, 'c.md', '3');
    await expect(
      call(owner, 'bucketMove', { bucketId, path: 'a', toPath: 'a/b/inner' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      call(owner, 'bucketMove', { bucketId, path: 'a/one.md', toPath: 'c.md' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    await call(owner, 'bucketMove', { bucketId, path: 'a', toPath: 'archive/2026/a2' });
    expect((await nodes(bucketId)).map((n) => n.path)).toEqual([
      'archive',
      'archive/2026',
      'archive/2026/a2',
      'archive/2026/a2/b',
      'archive/2026/a2/b/two.md',
      'archive/2026/a2/one.md',
      'c.md',
    ]);
    const read = await call(owner, 'bucketFileRead', {
      bucketId,
      path: 'archive/2026/a2/b/two.md',
    });
    expect(read.text).toBe('2');
    // A rename is a move in the same folder.
    await call(owner, 'bucketMove', { bucketId, path: 'c.md', toPath: 'readme.md' });
    expect((await call(owner, 'bucketFileRead', { bucketId, path: 'readme.md' })).text).toBe('3');
  });

  it('a folder move takes names past U+F8FF along (emoji, fullwidth), and only its own subtree', async () => {
    const { owner } = await people('owner');
    const bucketId = await newBucket(owner);
    await write(owner, bucketId, 'img/wallpapers/🐺.jpeg', 'w');
    await write(owner, bucketId, 'img/wallpapers/Ａ.txt', 'a');
    await write(owner, bucketId, 'img/wallpapers/b.txt', 'b');
    // siblings that only SHARE A PREFIX stay put
    await write(owner, bucketId, 'img/wallpapers0.txt', '0');
    await write(owner, bucketId, 'img/wallpapers-old/c.txt', 'c');
    await call(owner, 'bucketMove', { bucketId, path: 'img/wallpapers', toPath: 'wallpapers' });
    expect((await nodes(bucketId)).map((n) => n.path).sort()).toEqual(
      [
        'img',
        'img/wallpapers-old',
        'img/wallpapers-old/c.txt',
        'img/wallpapers0.txt',
        'wallpapers',
        'wallpapers/b.txt',
        'wallpapers/Ａ.txt',
        'wallpapers/🐺.jpeg',
      ].sort(),
    );
    // …and delete takes them too
    expect(
      (await call(owner, 'bucketNodeDelete', { bucketId, paths: ['wallpapers'] })).deleted,
    ).toBe(4);
  });

  it('delete is recursive; the counters and the Storage objects follow', async () => {
    const { owner } = await people('owner');
    const bucketId = await newBucket(owner);
    await write(owner, bucketId, 'a/one.md', '1');
    await write(owner, bucketId, 'a/b/two.md', '22');
    await write(owner, bucketId, 'keep.md', '333');
    const res = await call(owner, 'bucketNodeDelete', { bucketId, paths: ['a'] });
    expect(res.deleted).toBe(4);
    expect((await nodes(bucketId)).map((n) => n.path)).toEqual(['keep.md']);
    expect((await memDoc(bucketId))!.stats).toEqual({ files: 1, folders: 0, bytes: 3 });
    expect(await stored(`buckets/${bucketId}/`)).toHaveLength(1);
  });
});

describe('bucket: versions (D-M2)', () => {
  it('a new version is a new object, the old one goes; a stale save is refused', async () => {
    const { owner } = await people('owner');
    const bucketId = await newBucket(owner);
    const v1 = await write(owner, bucketId, 'spec.md', 'one');
    const before = await stored(`buckets/${bucketId}/`);
    expect(before).toEqual([bucketStoragePath(bucketId, v1.fileId, 'spec.md')]);
    const v2 = await write(owner, bucketId, 'spec.md', 'two!', { expectedFileId: v1.fileId });
    expect(v2.nodeId).toBe(v1.nodeId);
    expect(v2.fileId).not.toBe(v1.fileId);
    expect(await stored(`buckets/${bucketId}/`)).toEqual([
      bucketStoragePath(bucketId, v2.fileId, 'spec.md'),
    ]);
    expect((await memDoc(bucketId))!.stats.bytes).toBe(4);
    // An editor that opened v1 cannot overwrite v2 by accident.
    await expect(
      write(owner, bucketId, 'spec.md', 'three', { expectedFileId: v1.fileId }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // null = "must not exist yet".
    await expect(
      write(owner, bucketId, 'spec.md', 'x', { expectedFileId: null }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('bucketFilePut registers what the app uploaded, once', async () => {
    const { owner } = await people('owner');
    const bucketId = await newBucket(owner);
    const path = bucketStoragePath(bucketId, uniq('file'), 'shot.png');
    await bucket()
      .file(path)
      .save(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { contentType: 'image/png' });
    const put = await call(owner, 'bucketFilePut', {
      bucketId,
      path: 'img/shot.png',
      storagePath: path,
    });
    const node = (await nodes(bucketId)).find((n) => n.id === put.nodeId)!;
    expect(node.file).toMatchObject({ storagePath: path, mime: 'image/png', size: 4 });
    // The same object cannot back a second node (deleting one would take the other's bytes)…
    await expect(
      call(owner, 'bucketFilePut', { bucketId, path: 'img/copy.png', storagePath: path }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // …and that refusal leaves the object alone.
    expect(await stored(path)).toEqual([path]);
    // Retried: the same answer, nothing new.
    const again = await call(owner, 'bucketFilePut', {
      bucketId,
      path: 'img/shot.png',
      storagePath: path,
    });
    expect(again.nodeId).toBe(put.nodeId);
    // Somewhere else's path is refused.
    await expect(
      call(owner, 'bucketFilePut', {
        bucketId,
        path: 'x.png',
        storagePath: bucketStoragePath('other_bucket', 'file_x1', 'x.png'),
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('bucket: grants (§D)', () => {
  it("a board's members read; its editors write; the owner must be its admin to grant", async () => {
    const { owner, ed, com, outsider } = await people('owner', 'ed', 'com', 'outsider');
    const board = await seedBoard({ admin: owner, editors: [ed], commenters: [com] });
    const otherBoard = await seedBoard({ admin: outsider, editors: [owner] });
    const bucketId = await newBucket(owner);
    await write(owner, bucketId, 'brief.md', 'the brief');

    // Granting needs board ADMIN on the target.
    await expect(
      call(owner, 'bucketGrantSet', { bucketId, boardId: otherBoard.id, access: 'read' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await call(owner, 'bucketGrantSet', { bucketId, boardId: board.id, access: 'read' });
    expect((await memDoc(bucketId))!.boardIds).toEqual([board.id]);
    expect((await call(com, 'bucketFileRead', { bucketId, path: 'brief.md' })).text).toBe(
      'the brief',
    );
    await expect(write(ed, bucketId, 'x.md', 'x')).rejects.toMatchObject({ code: 'forbidden' });
    expect((await call(com, 'bucketList', { boardId: board.id })).buckets[0]).toMatchObject({
      id: bucketId,
      reach: 'read',
    });

    await call(owner, 'bucketGrantSet', { bucketId, boardId: board.id, access: 'write' });
    await write(ed, bucketId, 'from-editor.md', 'hi');
    await expect(write(com, bucketId, 'x.md', 'x')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(call(outsider, 'bucketTree', { bucketId })).rejects.toMatchObject({
      code: 'not_found',
    });

    // Only the owner shares or grants.
    await expect(
      call(ed, 'bucketGrantSet', { bucketId, boardId: board.id, access: null }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await call(owner, 'bucketGrantSet', { bucketId, boardId: board.id, access: null });
    await expect(call(com, 'bucketTree', { bucketId })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('an agent reaches bucket only through a board it is on', async () => {
    const { owner } = await people('owner');
    const board = await seedBoard({ admin: owner });
    const bucketId = await newBucket(owner);
    const onBoard = await makeAgent(owner, { boardId: board.id, role: 'editor' });
    const offBoard = await makeAgent(owner, { name: 'Loner' });
    const opts = { scopes: AGENT_TOKEN_SCOPES };

    await expect(asAgent(onBoard, 'bucketTree', { bucketId }, opts)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(asAgent(onBoard, 'bucketCreate', { name: 'mine' }, opts)).rejects.toMatchObject({
      code: 'forbidden',
    });

    await call(owner, 'bucketGrantSet', { bucketId, boardId: board.id, access: 'write' });
    await asAgent(
      onBoard,
      'bucketFileWrite',
      { bucketId, path: 'agent/plan.md', text: '# plan' },
      opts,
    );
    const listed = await asAgent(onBoard, 'bucketList', {}, opts);
    expect(listed.buckets.map((m) => [m.id, m.reach])).toEqual([[bucketId, 'write']]);
    await expect(asAgent(offBoard, 'bucketTree', { bucketId }, opts)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await nodes(bucketId)).find((n) => n.path === 'agent/plan.md')!.createdBy).toBe(
      onBoard.id,
    );
  });

  it('an artifact grant needs the artifact owner; bucketList narrows to it', async () => {
    const { owner, other } = await people('owner', 'other');
    const bucketId = await newBucket(owner);
    const { artifactId } = await call(owner, 'artifactCreate', { name: 'Dash' });
    const theirs = (await call(other, 'artifactCreate', { name: 'Theirs' })).artifactId;
    await expect(
      call(owner, 'bucketGrantSet', { bucketId, artifactId: theirs, access: 'read' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await call(owner, 'bucketGrantSet', { bucketId, artifactId, access: 'write' });
    expect((await memDoc(bucketId))!.artifacts).toEqual({ [artifactId]: 'write' });
    const list = await call(owner, 'bucketList', { artifactId });
    expect(list.buckets.map((m) => m.id)).toEqual([bucketId]);
  });
});

describe('bucket: either side ends a grant (§D, Subscriptions / Subscribers)', () => {
  it('a board admin drops a bucket from their board; an editor there cannot; a stranger learns nothing', async () => {
    const { owner, admin, ed, stranger } = await people('owner', 'admin', 'ed', 'stranger');
    const board = await seedBoard({ admin, editors: [ed, owner] });
    const ownBoard = await seedBoard({ admin: owner });
    const bucketId = await newBucket(owner);
    await call(owner, 'bucketGrantSet', { bucketId, boardId: ownBoard.id, access: 'read' });
    // The owner was this board's admin when they granted it (seeded straight in).
    await db()
      .doc(paths.bucket(bucketId))
      .update({ [`boards.${board.id}`]: 'write', boardIds: [board.id, ownBoard.id].sort() });

    await expect(
      call(ed, 'bucketGrantSet', { bucketId, boardId: board.id, access: null }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(stranger, 'bucketGrantSet', { bucketId, boardId: board.id, access: null }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // The board admin may END it but never GRANT or raise it (that is the owner's).
    await expect(
      call(admin, 'bucketGrantSet', { bucketId, boardId: board.id, access: 'read' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // …nor touch another board's grant.
    await expect(
      call(admin, 'bucketGrantSet', { bucketId, boardId: ownBoard.id, access: null }),
    ).rejects.toMatchObject({ code: 'not_found' });

    await call(admin, 'bucketGrantSet', { bucketId, boardId: board.id, access: null });
    const m = (await memDoc(bucketId))!;
    expect(m.boards).toEqual({ [ownBoard.id]: 'read' });
    expect(m.boardIds).toEqual([ownBoard.id]);
    await expect(call(ed, 'bucketTree', { bucketId })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it("an artifact's owner drops a bucket from their artifact; nobody else can", async () => {
    const { owner, other } = await people('owner', 'other');
    const bucketId = await newBucket(owner);
    const { artifactId } = await call(owner, 'artifactCreate', { name: 'Dash' });
    await call(owner, 'bucketGrantSet', { bucketId, artifactId, access: 'read' });
    // The bucket's owner is also the artifact's owner here; hand the artifact
    // side to someone else by checking the refusal for a non-owner first.
    await expect(
      call(other, 'bucketGrantSet', { bucketId, artifactId, access: null }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await call(owner, 'artifactShare', { artifactId, email: other.email, role: 'editor' });
    await expect(
      call(other, 'bucketGrantSet', { bucketId, artifactId, access: null }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // Someone who owns an artifact but not the bucket: the artifact side ends it.
    const theirs = (await call(other, 'artifactCreate', { name: 'Theirs' })).artifactId;
    await db()
      .doc(paths.bucket(bucketId))
      .update({ [`artifacts.${theirs}`]: 'write' });
    await call(other, 'bucketGrantSet', { bucketId, artifactId: theirs, access: null });
    expect((await memDoc(bucketId))!.artifacts).toEqual({ [artifactId]: 'read' });
    // …and only their own artifact's grant.
    await expect(
      call(other, 'bucketGrantSet', { bucketId, artifactId, access: null }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('bucket: files on tickets (§E)', () => {
  it('a ticket points at the node: the door serves the CURRENT version, until the grant goes', async () => {
    const { owner, com } = await people('owner', 'com');
    const board = await seedBoard({ admin: owner, commenters: [com] });
    const bucketId = await newBucket(owner);
    const v1 = await write(owner, bucketId, 'shots/home.md', 'v1');
    const { ticketId } = await call(owner, 'ticketCreate', { boardId: board.id, title: 'Ref' });

    // Not granted to this board yet → refused.
    await expect(
      call(owner, 'messagePost', {
        boardId: board.id,
        ticketId,
        body: doc('see'),
        clientId: uniq('c'),
        bucketRefs: [{ bucketId, nodeId: v1.nodeId }],
      }),
    ).rejects.toMatchObject({ code: 'invalid' });

    await call(owner, 'bucketGrantSet', { bucketId, boardId: board.id, access: 'read' });
    await call(com, 'messagePost', {
      boardId: board.id,
      ticketId,
      body: doc('see this'),
      clientId: uniq('c'),
      bucketRefs: [{ bucketId, nodeId: v1.nodeId }],
    });
    const t = (await db().doc(paths.ticket(board.id, ticketId)).get()).data()!;
    const row = (
      t.files as { source: string; path: string; bucket?: unknown; name: string }[]
    ).find((f) => f.source === 'bucket')!;
    expect(row).toMatchObject({
      path: `buckets/${bucketId}/nodes/${v1.nodeId}`,
      bucket: { bucketId, nodeId: v1.nodeId },
      name: 'home.md',
    });
    expect(t.counts.files).toBe(1);

    const first = await fileUrl(com, row.path);
    expect(first.status).toBe(200);
    expect(decodeURIComponent((first.body as { bytesUrl: string }).bytesUrl)).toContain(v1.fileId);

    // Edited in the bucket → every ticket pointing at it sees the new version.
    const v2 = await write(owner, bucketId, 'shots/home.md', 'v2');
    const second = await fileUrl(com, row.path);
    expect(decodeURIComponent((second.body as { bytesUrl: string }).bytesUrl)).toContain(v2.fileId);

    // The grant goes: the board member loses it, the owner (a role) keeps it.
    await call(owner, 'bucketGrantSet', { bucketId, boardId: board.id, access: null });
    expect((await fileUrl(com, row.path)).status).toBe(404);
    expect((await fileUrl(owner, row.path)).status).toBe(200);

    // Deleted from bucket: gone for everyone.
    await call(owner, 'bucketNodeDelete', { bucketId, paths: ['shots/home.md'] });
    expect((await fileUrl(owner, row.path)).status).toBe(404);
  });
});

describe('bucket: delete (§G)', () => {
  inProcess(
    'gone for everyone at once; the job removes files, nodes and the document',
    async () => {
      const { owner, ed } = await people('owner', 'ed');
      const bucketId = await newBucket(owner);
      await call(owner, 'bucketShare', { bucketId, email: ed.email, role: 'editor' });
      await write(ed, bucketId, 'a/b.md', 'x');
      await expect(call(ed, 'bucketDelete', { bucketId })).rejects.toMatchObject({
        code: 'forbidden',
      });
      await call(owner, 'bucketDelete', { bucketId });
      expect(await memDoc(bucketId)).toMatchObject({
        access: {},
        memberUids: [],
        deletingAt: expect.any(Number),
      });
      for (const who of [owner, ed])
        await expect(call(who, 'bucketTree', { bucketId })).rejects.toMatchObject({
          code: 'not_found',
        });

      await queue().drain({ queue: 'bucketDelete' });
      expect(await memDoc(bucketId)).toBeUndefined();
      expect(await nodes(bucketId)).toEqual([]);
      expect(await stored(`buckets/${bucketId}/`)).toEqual([]);
    },
  );
});

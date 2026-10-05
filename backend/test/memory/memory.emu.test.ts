/**
 * MEMORY (docs/plan/memory.html) — the commands, end to end on the emulators:
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
  memoryStoragePath,
  paths,
  type Memory,
  type MemoryNode,
} from '@tm/shared';
import { db, storageAdmin } from '../../src/runtime/firebase.js';
import { asAgent, makeAgent } from '../agents/helpers.js';
import { call, queue, request, setupEmulators, uniq, type TestUser } from '../harness/index.js';
import { doc, people, seedBoard } from '../tickets/helpers.js';

setupEmulators();

const inProcess = it.skipIf(!!process.env.TM_API_URL);
const bucket = () => storageAdmin().bucket();
const stored = async (prefix: string) =>
  (await bucket().getFiles({ prefix }))[0].map((f) => f.name).sort();
const memDoc = async (id: string) =>
  (await db().doc(paths.memory(id)).get()).data() as Memory | undefined;
const nodes = async (id: string) =>
  (await db().collection(paths.memoryNodes(id)).get()).docs
    .map((d) => ({ id: d.id, ...(d.data() as MemoryNode) }))
    .sort((a, b) => a.path.localeCompare(b.path));

async function newMemory(owner: TestUser, name = 'Brand kit'): Promise<string> {
  return (await call(owner, 'memoryCreate', { name })).memoryId;
}
const write = (u: TestUser, memoryId: string, path: string, text: string, extra: object = {}) =>
  call(u, 'memoryFileWrite', { memoryId, path, text, ...extra });

const fileUrl = (u: TestUser, path: string) =>
  request(`/api/files/url?path=${encodeURIComponent(path)}`, {
    headers: { authorization: `Bearer ${u.token}` },
  });

describe('memory: people (§B)', () => {
  it('owner manages, editor writes, viewer reads, a stranger finds nothing', async () => {
    const { owner, ed, view, stranger } = await people('owner', 'ed', 'view', 'stranger');
    const memoryId = await newMemory(owner);
    await call(owner, 'memoryShare', { memoryId, email: ed.email, role: 'editor' });
    await call(owner, 'memoryShare', { memoryId, email: view.email, role: 'viewer' });
    expect((await memDoc(memoryId))!.memberUids).toEqual([owner.uid, ed.uid, view.uid].sort());

    await write(ed, memoryId, 'notes/hello.md', '# Hello');
    const read = await call(view, 'memoryFileRead', { memoryId, path: 'notes/hello.md' });
    expect(read.text).toBe('# Hello');
    expect(read.node).toMatchObject({ kind: 'file', name: 'hello.md', path: 'notes/hello.md' });
    expect(read.url).toBeTruthy();

    await expect(write(view, memoryId, 'x.md', 'no')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(ed, 'memoryShare', { memoryId, email: stranger.email, role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(call(stranger, 'memoryTree', { memoryId })).rejects.toMatchObject({
      code: 'not_found',
    });
    // An unknown address is not invited (yet): it says so.
    await expect(
      call(owner, 'memoryShare', { memoryId, email: `${uniq('nobody')}@test.dev`, role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // Taking the role away takes the reach away.
    await call(owner, 'memoryShare', { memoryId, email: view.email, role: null });
    await expect(call(view, 'memoryTree', { memoryId })).rejects.toMatchObject({
      code: 'not_found',
    });

    const list = await call(ed, 'memoryList', {});
    expect(list.memories.map((m) => [m.id, m.reach])).toEqual([[memoryId, 'write']]);
  });

  it('archived: read-only until the owner restores it', async () => {
    const { owner } = await people('owner');
    const memoryId = await newMemory(owner);
    await call(owner, 'memoryUpdate', { memoryId, archived: true, name: 'Old kit' });
    await expect(write(owner, memoryId, 'a.md', 'x')).rejects.toMatchObject({ code: 'conflict' });
    expect((await call(owner, 'memoryList', {})).memories).toEqual([]);
    expect((await call(owner, 'memoryList', { includeArchived: true })).memories[0]).toMatchObject({
      name: 'Old kit',
      archived: true,
    });
    await call(owner, 'memoryUpdate', { memoryId, archived: false });
    await write(owner, memoryId, 'a.md', 'x');
  });
});

describe('memory: paths (§A)', () => {
  it('parents are created; a file in the way and a taken path are refused', async () => {
    const { owner } = await people('owner');
    const memoryId = await newMemory(owner);
    await write(owner, memoryId, '/docs//brand/ logo.svg ', '<svg/>');
    expect((await nodes(memoryId)).map((n) => [n.path, n.kind])).toEqual([
      ['docs', 'folder'],
      ['docs/brand', 'folder'],
      ['docs/brand/logo.svg', 'file'],
    ]);
    const tree = await call(owner, 'memoryTree', { memoryId, path: 'docs', shallow: true });
    expect(tree.nodes.map((n) => n.path)).toEqual(['docs/brand']);
    expect((await memDoc(memoryId))!.stats).toEqual({ files: 1, folders: 2, bytes: 6 });

    // mkdir -p: an existing folder is fine, a file in the way is not.
    const again = await call(owner, 'memoryFolderCreate', { memoryId, path: 'docs/brand' });
    expect(again.path).toBe('docs/brand');
    await expect(
      call(owner, 'memoryFolderCreate', { memoryId, path: 'docs/brand/logo.svg/x' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(write(owner, memoryId, 'docs', 'x')).rejects.toMatchObject({ code: 'conflict' });
    await expect(write(owner, memoryId, 'a/../b', 'x')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a folder move takes its subtree; moving inside itself or onto something is refused', async () => {
    const { owner } = await people('owner');
    const memoryId = await newMemory(owner);
    await write(owner, memoryId, 'a/one.md', '1');
    await write(owner, memoryId, 'a/b/two.md', '2');
    await write(owner, memoryId, 'c.md', '3');
    await expect(
      call(owner, 'memoryMove', { memoryId, path: 'a', toPath: 'a/b/inner' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      call(owner, 'memoryMove', { memoryId, path: 'a/one.md', toPath: 'c.md' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    await call(owner, 'memoryMove', { memoryId, path: 'a', toPath: 'archive/2026/a2' });
    expect((await nodes(memoryId)).map((n) => n.path)).toEqual([
      'archive',
      'archive/2026',
      'archive/2026/a2',
      'archive/2026/a2/b',
      'archive/2026/a2/b/two.md',
      'archive/2026/a2/one.md',
      'c.md',
    ]);
    const read = await call(owner, 'memoryFileRead', {
      memoryId,
      path: 'archive/2026/a2/b/two.md',
    });
    expect(read.text).toBe('2');
    // A rename is a move in the same folder.
    await call(owner, 'memoryMove', { memoryId, path: 'c.md', toPath: 'readme.md' });
    expect((await call(owner, 'memoryFileRead', { memoryId, path: 'readme.md' })).text).toBe('3');
  });

  it('delete is recursive; the counters and the Storage objects follow', async () => {
    const { owner } = await people('owner');
    const memoryId = await newMemory(owner);
    await write(owner, memoryId, 'a/one.md', '1');
    await write(owner, memoryId, 'a/b/two.md', '22');
    await write(owner, memoryId, 'keep.md', '333');
    const res = await call(owner, 'memoryNodeDelete', { memoryId, paths: ['a'] });
    expect(res.deleted).toBe(4);
    expect((await nodes(memoryId)).map((n) => n.path)).toEqual(['keep.md']);
    expect((await memDoc(memoryId))!.stats).toEqual({ files: 1, folders: 0, bytes: 3 });
    expect(await stored(`memories/${memoryId}/`)).toHaveLength(1);
  });
});

describe('memory: versions (D-M2)', () => {
  it('a new version is a new object, the old one goes; a stale save is refused', async () => {
    const { owner } = await people('owner');
    const memoryId = await newMemory(owner);
    const v1 = await write(owner, memoryId, 'spec.md', 'one');
    const before = await stored(`memories/${memoryId}/`);
    expect(before).toEqual([memoryStoragePath(memoryId, v1.fileId, 'spec.md')]);
    const v2 = await write(owner, memoryId, 'spec.md', 'two!', { expectedFileId: v1.fileId });
    expect(v2.nodeId).toBe(v1.nodeId);
    expect(v2.fileId).not.toBe(v1.fileId);
    expect(await stored(`memories/${memoryId}/`)).toEqual([
      memoryStoragePath(memoryId, v2.fileId, 'spec.md'),
    ]);
    expect((await memDoc(memoryId))!.stats.bytes).toBe(4);
    // An editor that opened v1 cannot overwrite v2 by accident.
    await expect(
      write(owner, memoryId, 'spec.md', 'three', { expectedFileId: v1.fileId }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // null = "must not exist yet".
    await expect(
      write(owner, memoryId, 'spec.md', 'x', { expectedFileId: null }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('memoryFilePut registers what the app uploaded, once', async () => {
    const { owner } = await people('owner');
    const memoryId = await newMemory(owner);
    const path = memoryStoragePath(memoryId, uniq('file'), 'shot.png');
    await bucket()
      .file(path)
      .save(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { contentType: 'image/png' });
    const put = await call(owner, 'memoryFilePut', {
      memoryId,
      path: 'img/shot.png',
      storagePath: path,
    });
    const node = (await nodes(memoryId)).find((n) => n.id === put.nodeId)!;
    expect(node.file).toMatchObject({ storagePath: path, mime: 'image/png', size: 4 });
    // The same object cannot back a second node (deleting one would take the other's bytes)…
    await expect(
      call(owner, 'memoryFilePut', { memoryId, path: 'img/copy.png', storagePath: path }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // …and that refusal leaves the object alone.
    expect(await stored(path)).toEqual([path]);
    // Retried: the same answer, nothing new.
    const again = await call(owner, 'memoryFilePut', {
      memoryId,
      path: 'img/shot.png',
      storagePath: path,
    });
    expect(again.nodeId).toBe(put.nodeId);
    // Somewhere else's path is refused.
    await expect(
      call(owner, 'memoryFilePut', {
        memoryId,
        path: 'x.png',
        storagePath: memoryStoragePath('other_memory', 'file_x1', 'x.png'),
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('memory: grants (§D)', () => {
  it("a board's members read; its editors write; the owner must be its admin to grant", async () => {
    const { owner, ed, com, outsider } = await people('owner', 'ed', 'com', 'outsider');
    const board = await seedBoard({ admin: owner, editors: [ed], commenters: [com] });
    const otherBoard = await seedBoard({ admin: outsider, editors: [owner] });
    const memoryId = await newMemory(owner);
    await write(owner, memoryId, 'brief.md', 'the brief');

    // Granting needs board ADMIN on the target.
    await expect(
      call(owner, 'memoryGrantSet', { memoryId, boardId: otherBoard.id, access: 'read' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await call(owner, 'memoryGrantSet', { memoryId, boardId: board.id, access: 'read' });
    expect((await memDoc(memoryId))!.boardIds).toEqual([board.id]);
    expect((await call(com, 'memoryFileRead', { memoryId, path: 'brief.md' })).text).toBe(
      'the brief',
    );
    await expect(write(ed, memoryId, 'x.md', 'x')).rejects.toMatchObject({ code: 'forbidden' });
    expect((await call(com, 'memoryList', { boardId: board.id })).memories[0]).toMatchObject({
      id: memoryId,
      reach: 'read',
    });

    await call(owner, 'memoryGrantSet', { memoryId, boardId: board.id, access: 'write' });
    await write(ed, memoryId, 'from-editor.md', 'hi');
    await expect(write(com, memoryId, 'x.md', 'x')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(call(outsider, 'memoryTree', { memoryId })).rejects.toMatchObject({
      code: 'not_found',
    });

    // Only the owner shares or grants.
    await expect(
      call(ed, 'memoryGrantSet', { memoryId, boardId: board.id, access: null }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await call(owner, 'memoryGrantSet', { memoryId, boardId: board.id, access: null });
    await expect(call(com, 'memoryTree', { memoryId })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('an agent reaches memory only through a board it is on', async () => {
    const { owner } = await people('owner');
    const board = await seedBoard({ admin: owner });
    const memoryId = await newMemory(owner);
    const onBoard = await makeAgent(owner, { boardId: board.id, role: 'editor' });
    const offBoard = await makeAgent(owner, { name: 'Loner' });
    const opts = { scopes: AGENT_TOKEN_SCOPES };

    await expect(asAgent(onBoard, 'memoryTree', { memoryId }, opts)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(asAgent(onBoard, 'memoryCreate', { name: 'mine' }, opts)).rejects.toMatchObject({
      code: 'forbidden',
    });

    await call(owner, 'memoryGrantSet', { memoryId, boardId: board.id, access: 'write' });
    await asAgent(
      onBoard,
      'memoryFileWrite',
      { memoryId, path: 'agent/plan.md', text: '# plan' },
      opts,
    );
    const listed = await asAgent(onBoard, 'memoryList', {}, opts);
    expect(listed.memories.map((m) => [m.id, m.reach])).toEqual([[memoryId, 'write']]);
    await expect(asAgent(offBoard, 'memoryTree', { memoryId }, opts)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await nodes(memoryId)).find((n) => n.path === 'agent/plan.md')!.createdBy).toBe(
      onBoard.id,
    );
  });

  it('an artifact grant needs the artifact owner; memoryList narrows to it', async () => {
    const { owner, other } = await people('owner', 'other');
    const memoryId = await newMemory(owner);
    const { artifactId } = await call(owner, 'artifactCreate', { name: 'Dash' });
    const theirs = (await call(other, 'artifactCreate', { name: 'Theirs' })).artifactId;
    await expect(
      call(owner, 'memoryGrantSet', { memoryId, artifactId: theirs, access: 'read' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await call(owner, 'memoryGrantSet', { memoryId, artifactId, access: 'write' });
    expect((await memDoc(memoryId))!.artifacts).toEqual({ [artifactId]: 'write' });
    const list = await call(owner, 'memoryList', { artifactId });
    expect(list.memories.map((m) => m.id)).toEqual([memoryId]);
  });
});

describe('memory: files on tickets (§E)', () => {
  it('a ticket points at the node: the door serves the CURRENT version, until the grant goes', async () => {
    const { owner, com } = await people('owner', 'com');
    const board = await seedBoard({ admin: owner, commenters: [com] });
    const memoryId = await newMemory(owner);
    const v1 = await write(owner, memoryId, 'shots/home.md', 'v1');
    const { ticketId } = await call(owner, 'ticketCreate', { boardId: board.id, title: 'Ref' });

    // Not granted to this board yet → refused.
    await expect(
      call(owner, 'messagePost', {
        boardId: board.id,
        ticketId,
        body: doc('see'),
        clientId: uniq('c'),
        memoryRefs: [{ memoryId, nodeId: v1.nodeId }],
      }),
    ).rejects.toMatchObject({ code: 'invalid' });

    await call(owner, 'memoryGrantSet', { memoryId, boardId: board.id, access: 'read' });
    await call(com, 'messagePost', {
      boardId: board.id,
      ticketId,
      body: doc('see this'),
      clientId: uniq('c'),
      memoryRefs: [{ memoryId, nodeId: v1.nodeId }],
    });
    const t = (await db().doc(paths.ticket(board.id, ticketId)).get()).data()!;
    const row = (
      t.files as { source: string; path: string; memory?: unknown; name: string }[]
    ).find((f) => f.source === 'memory')!;
    expect(row).toMatchObject({
      path: `memories/${memoryId}/nodes/${v1.nodeId}`,
      memory: { memoryId, nodeId: v1.nodeId },
      name: 'home.md',
    });
    expect(t.counts.files).toBe(1);

    const first = await fileUrl(com, row.path);
    expect(first.status).toBe(200);
    expect(decodeURIComponent((first.body as { bytesUrl: string }).bytesUrl)).toContain(v1.fileId);

    // Edited in the memory → every ticket pointing at it sees the new version.
    const v2 = await write(owner, memoryId, 'shots/home.md', 'v2');
    const second = await fileUrl(com, row.path);
    expect(decodeURIComponent((second.body as { bytesUrl: string }).bytesUrl)).toContain(v2.fileId);

    // The grant goes: the board member loses it, the owner (a role) keeps it.
    await call(owner, 'memoryGrantSet', { memoryId, boardId: board.id, access: null });
    expect((await fileUrl(com, row.path)).status).toBe(404);
    expect((await fileUrl(owner, row.path)).status).toBe(200);

    // Deleted from memory: gone for everyone.
    await call(owner, 'memoryNodeDelete', { memoryId, paths: ['shots/home.md'] });
    expect((await fileUrl(owner, row.path)).status).toBe(404);
  });
});

describe('memory: delete (§G)', () => {
  inProcess(
    'gone for everyone at once; the job removes files, nodes and the document',
    async () => {
      const { owner, ed } = await people('owner', 'ed');
      const memoryId = await newMemory(owner);
      await call(owner, 'memoryShare', { memoryId, email: ed.email, role: 'editor' });
      await write(ed, memoryId, 'a/b.md', 'x');
      await expect(call(ed, 'memoryDelete', { memoryId })).rejects.toMatchObject({
        code: 'forbidden',
      });
      await call(owner, 'memoryDelete', { memoryId });
      expect(await memDoc(memoryId)).toMatchObject({
        access: {},
        memberUids: [],
        deletingAt: expect.any(Number),
      });
      for (const who of [owner, ed])
        await expect(call(who, 'memoryTree', { memoryId })).rejects.toMatchObject({
          code: 'not_found',
        });

      await queue().drain({ queue: 'memoryDelete' });
      expect(await memDoc(memoryId)).toBeUndefined();
      expect(await nodes(memoryId)).toEqual([]);
      expect(await stored(`memories/${memoryId}/`)).toEqual([]);
    },
  );

  it('workspaces bundle memories; sidebarHide hides them; only ones you reach', async () => {
    const { owner, other } = await people('owner', 'other');
    const memoryId = await newMemory(owner);
    const theirs = await newMemory(other);
    const { workspaceId } = await call(owner, 'workspaceCreate', {
      name: 'Brand',
      memoryIds: [memoryId],
    });
    expect(
      (await db().doc(paths.workspace(owner.uid, workspaceId)).get()).data()!.memoryIds,
    ).toEqual([memoryId]);
    await expect(
      call(owner, 'workspaceUpdate', { workspaceId, add: { memoryIds: [theirs] } }),
    ).rejects.toMatchObject({ code: 'invalid', details: { memoryIds: [theirs] } });
    await call(owner, 'sidebarHide', { memoryId, hidden: true });
    expect((await db().doc(paths.sidebarPrefs(owner.uid)).get()).data()!.hiddenMemoryIds).toEqual([
      memoryId,
    ]);
  });
});

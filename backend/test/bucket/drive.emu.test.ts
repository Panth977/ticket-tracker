/**
 * BUCKETS IN GOOGLE DRIVE (docs/plan/bucket.html §K), on the emulators, with
 * the in-memory fake Drive (TM_DRIVE unset + emulators → fake):
 *
 *   §K1  connect: driveConnect → the callback → driveStatus; disconnect
 *   §K2  Drive is the truth: the commands read and write Drive, no Firestore
 *        nodes; a rename made IN DRIVE is what the next read sees
 *   §K3  the file door serves a Drive file (a ticket reference follows it)
 *   §K4  app uploads are staged, then moved into Drive; ticket files are
 *        planned in the transaction and placed after it
 *   people reach it through the server — a viewer needs no Drive of their own
 */
import { describe, expect, it } from 'vitest';
import { paths, type Board, type Bucket } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { fakeDriveTouch } from '../../src/bucket/drive/api.js';
import {
  call,
  callRaw,
  ports,
  queue,
  request,
  setupEmulators,
  uniq,
  type TestUser,
} from '../harness/index.js';
import { doc, people, seedBoard } from '../tickets/helpers.js';

setupEmulators();

const inProcess = it.skipIf(!!process.env.TM_API_URL);
const memDoc = async (id: string) =>
  (await db().doc(paths.bucket(id)).get()).data() as Bucket | undefined;
const firestoreNodes = async (id: string) =>
  (await db().collection(paths.bucketNodes(id)).get()).size;

/** Connect a person's (fake) Drive through the real round trip. */
async function connect(u: TestUser): Promise<void> {
  const { url } = await call(u, 'driveConnect', { returnTo: '/account/connections' });
  expect(url).toMatch(/^\/integrations\/drive\/callback\?state=/);
  const res = await request(url);
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/account/connections?drive=connected');
}

async function driveBucket(owner: TestUser, name = 'Specs'): Promise<string> {
  return (await call(owner, 'bucketCreate', { name, storage: { kind: 'drive' } })).bucketId;
}

const paths_ = (nodes: { path: string }[]) => nodes.map((n) => n.path);

describe('Drive connection (§K1)', () => {
  inProcess('connect, status, disconnect; a Drive bucket needs a connection', async () => {
    const { me } = await people('me');
    expect(await call(me, 'driveStatus', {})).toMatchObject({ available: true, connected: false });
    const refused = await callRaw(me, 'bucketCreate', { name: 'X', storage: { kind: 'drive' } });
    expect(refused.status).toBe(409);

    await connect(me);
    const st = await call(me, 'driveStatus', {});
    expect(st.connected).toBe(true);
    expect(st.email).toMatch(/@drive\.test$/);

    await call(me, 'driveDisconnect', {});
    expect((await call(me, 'driveStatus', {})).connected).toBe(false);
  });

  inProcess('a forged or stale state is refused', async () => {
    const res = await request('/integrations/drive/callback?state=abc.def&code=x');
    expect(res.status).toBe(403);
  });
});

describe('Drive bucket: Drive is the truth (§K2)', () => {
  inProcess('create → write → tree → read → move → delete, all in Drive', async () => {
    const { owner } = await people('owner');
    await connect(owner);
    const bucketId = await driveBucket(owner);
    const m = (await memDoc(bucketId))!;
    expect(m.storage).toMatchObject({ kind: 'drive', uid: owner.uid, folderName: 'Specs' });

    const w = await call(owner, 'bucketFileWrite', {
      bucketId,
      path: 'notes/hello.md',
      text: '# Hello',
    });
    await call(owner, 'bucketFolderCreate', { bucketId, path: 'empty/inner' });
    const tree = await call(owner, 'bucketTree', { bucketId });
    expect(paths_(tree.nodes)).toEqual(['empty', 'empty/inner', 'notes', 'notes/hello.md']);
    expect(await firestoreNodes(bucketId)).toBe(0);
    // Firebase holds only where the data is: the bucket document never changed.
    expect(await memDoc(bucketId)).toEqual(m);

    const read = await call(owner, 'bucketFileRead', { bucketId, path: 'notes/hello.md' });
    expect(read.text).toBe('# Hello');
    expect(read.node.id).toBe(w.nodeId);
    expect(read.url).toContain('/files/blob');

    // A new version: same node, new revision; a stale save is refused.
    const v2 = await call(owner, 'bucketFileWrite', {
      bucketId,
      nodeId: w.nodeId,
      text: '# Hello 2',
      expectedFileId: w.fileId,
    });
    expect(v2.nodeId).toBe(w.nodeId);
    expect(v2.fileId).not.toBe(w.fileId);
    const stale = await callRaw(owner, 'bucketFileWrite', {
      bucketId,
      nodeId: w.nodeId,
      text: 'lost',
      expectedFileId: w.fileId,
    });
    expect(stale.status).toBe(409);

    // Move a folder: its file goes along, the id stays.
    await call(owner, 'bucketMove', { bucketId, path: 'notes', toPath: 'archive/notes' });
    const moved = await call(owner, 'bucketFileRead', { bucketId, nodeId: w.nodeId });
    expect(moved.node.path).toBe('archive/notes/hello.md');
    const inside = await callRaw(owner, 'bucketMove', {
      bucketId,
      path: 'archive',
      toPath: 'archive/x/archive',
    });
    expect(inside.status).toBe(409);

    const del = await call(owner, 'bucketNodeDelete', { bucketId, paths: ['archive'] });
    expect(del.deleted).toBe(3);
    expect(paths_((await call(owner, 'bucketTree', { bucketId })).nodes)).toEqual([
      'empty',
      'empty/inner',
    ]);
  });

  inProcess('a rename made in Drive itself is what the app sees next', async () => {
    const { owner } = await people('owner');
    await connect(owner);
    const bucketId = await driveBucket(owner);
    const w = await call(owner, 'bucketFileWrite', { bucketId, path: 'a.txt', text: 'x' });
    fakeDriveTouch(owner.uid, w.nodeId, { name: 'renamed in drive.txt' });
    const tree = await call(owner, 'bucketTree', { bucketId });
    expect(paths_(tree.nodes)).toEqual(['renamed in drive.txt']);
    // Names a path cannot hold get a stand-in, not an error.
    fakeDriveTouch(owner.uid, w.nodeId, { name: 'a/b.txt' });
    expect(paths_((await call(owner, 'bucketTree', { bucketId })).nodes)).toEqual(['a∕b.txt']);
  });

  inProcess(
    'people reach it through the server: a viewer needs no Drive; a stranger gets 404',
    async () => {
      const { owner, view, stranger } = await people('owner', 'view', 'stranger');
      await connect(owner);
      const bucketId = await driveBucket(owner);
      await call(owner, 'bucketShare', { bucketId, email: view.email, role: 'viewer' });
      await call(owner, 'bucketFileWrite', { bucketId, path: 'doc.md', text: 'shared' });
      expect((await call(view, 'bucketFileRead', { bucketId, path: 'doc.md' })).text).toBe(
        'shared',
      );
      expect(
        (await callRaw(view, 'bucketFileWrite', { bucketId, path: 'x.md', text: 'n' })).status,
      ).toBe(403);
      expect((await callRaw(stranger, 'bucketTree', { bucketId })).status).toBe(404);

      // The owner disconnects: the bucket stays, but answers 409 until reconnected.
      await call(owner, 'driveDisconnect', {});
      const off = await callRaw(view, 'bucketTree', { bucketId });
      expect(off.status).toBe(409);
      expect(JSON.stringify(off.body)).toContain('drive_disconnected');
    },
  );

  inProcess('a folder path is made in the top level of the Drive, and reused', async () => {
    const { owner } = await people('owner');
    await connect(owner);
    const a = await call(owner, 'bucketCreate', {
      name: 'One',
      storage: { kind: 'drive', folderPath: 'Work/Shared' },
    });
    const b = await call(owner, 'bucketCreate', {
      name: 'Two',
      storage: { kind: 'drive', folderPath: 'Work/Shared' },
    });
    const sa = (await memDoc(a.bucketId))!.storage!;
    const sb = (await memDoc(b.bucketId))!.storage!;
    expect(sa.folderName).toBe('Shared');
    expect(sb.folderId).toBe(sa.folderId);
  });
});

/** The browser's side of §K4: open a Drive upload, PUT the bytes to it. */
async function driveUpload(
  u: TestUser,
  input: Record<string, unknown>,
  bytes: Uint8Array,
): Promise<{ storagePath: string; driveId: string; path: string }> {
  const r = await call(u, 'bucketDriveUpload', {
    mime: 'image/png',
    size: bytes.byteLength,
    ...input,
  } as never);
  const put = await request(r.uploadUrl, { method: 'PUT', body: bytes });
  expect(put.status).toBe(200);
  return r;
}

/** Every object under a prefix of our own store (there must be none for Drive buckets). */
const ourObjects = async (bucketId: string) =>
  (await ports().files.list(`buckets/${bucketId}/`)).length;

describe('Drive bucket files on tickets (§K3, §K4)', () => {
  inProcess(
    'an app upload goes straight into Drive; our object store is never touched',
    async () => {
      const { owner } = await people('owner');
      await connect(owner);
      const bucketId = await driveBucket(owner);
      const before = await memDoc(bucketId);
      const up = await driveUpload(
        owner,
        { bucketId, purpose: 'put', path: 'img/pic.png', name: 'pic.png' },
        new Uint8Array([9, 8, 7]),
      );
      const put = await call(owner, 'bucketFilePut', {
        bucketId,
        path: 'img/pic.png',
        storagePath: up.storagePath,
      });
      expect(put.nodeId).toBe(up.driveId);
      expect(put.path).toBe('img/pic.png');
      const read = await call(owner, 'bucketFileRead', { bucketId, nodeId: put.nodeId });
      expect(read.node.file).toMatchObject({ mime: 'image/png', size: 3 });
      expect((await request(read.bytesUrl)).status).toBe(200);

      // A new version of the same file, with the stale guard.
      const v2 = await driveUpload(
        owner,
        {
          bucketId,
          purpose: 'put',
          nodeId: put.nodeId,
          name: 'pic.png',
          expectedFileId: put.fileId,
        },
        new Uint8Array([1, 2, 3, 4]),
      );
      expect(v2.driveId).toBe(put.nodeId);
      const stale = await callRaw(owner, 'bucketDriveUpload', {
        bucketId,
        purpose: 'put',
        nodeId: put.nodeId,
        name: 'pic.png',
        mime: 'image/png',
        size: 1,
        expectedFileId: put.fileId,
      });
      expect(stale.status).toBe(409);

      expect(await ourObjects(bucketId)).toBe(0);
      expect(await memDoc(bucketId)).toEqual(before);
    },
  );

  inProcess(
    "ticket files: uploaded into Drive's staging, placed after the commit; '<ticketId>' filled",
    async () => {
      const { owner, com } = await people('owner', 'com');
      await connect(owner);
      const b = await seedBoard({ admin: owner, commenters: [com] });
      const bucketId = await driveBucket(owner, 'Ticket files');
      await call(owner, 'bucketGrantSet', { bucketId, boardId: b.id, access: 'write' });
      const { ticketId, key } = await call(owner, 'ticketCreate', {
        boardId: b.id,
        title: 'Shots',
      });
      // A commenter has no role on the bucket, yet may put a NEW file in through the board.
      const s1 = await driveUpload(
        com,
        { bucketId, purpose: 'attach', boardId: b.id, name: 'shot.png' },
        new Uint8Array([1]),
      );
      const s2 = await driveUpload(
        com,
        { bucketId, purpose: 'attach', boardId: b.id, name: 'shot.png' },
        new Uint8Array([2]),
      );
      // Staged files are not in the bucket yet.
      expect((await call(owner, 'bucketTree', { bucketId })).nodes).toEqual([]);
      await call(com, 'messagePost', {
        boardId: b.id,
        ticketId,
        clientId: uniq('c'),
        body: doc('files'),
        bucketUploads: [
          { bucketId, path: 'tickets/<ticketId>/shot.png', storagePath: s1.storagePath },
          { bucketId, path: 'tickets/<ticketId>/shot.png', storagePath: s2.storagePath },
        ],
      });
      const tree = await call(owner, 'bucketTree', { bucketId });
      expect(paths_(tree.nodes)).toEqual([
        'tickets',
        `tickets/${key}`,
        `tickets/${key}/shot (2).png`,
        `tickets/${key}/shot.png`,
      ]);
      expect(await ourObjects(bucketId)).toBe(0);

      // The ticket's reference opens through the file door, and follows a move.
      const ticket = (await db().doc(paths.ticket(b.id, ticketId)).get()).data() as {
        files: { path: string; bucket?: { nodeId: string } }[];
      };
      const ref = ticket.files.find((f) => f.bucket)!;
      expect([s1.driveId, s2.driveId]).toContain(ref.bucket!.nodeId);
      const fileUrl = (p: string) =>
        request(`/api/files/url?path=${encodeURIComponent(p)}`, {
          headers: { authorization: `Bearer ${com.token}` },
        });
      expect((await fileUrl(ref.path)).status).toBe(200);
      await call(owner, 'bucketMove', {
        bucketId,
        nodeId: ref.bucket!.nodeId,
        toPath: 'moved.png',
      });
      expect((await fileUrl(ref.path)).status).toBe(200);
    },
  );

  inProcess('a refused post trashes its staged Drive file', async () => {
    const { owner, view } = await people('owner', 'view');
    await connect(owner);
    const b = await seedBoard({ admin: owner, commenters: [view] });
    const bucketId = await driveBucket(owner, 'Ticket files');
    await call(owner, 'bucketGrantSet', { bucketId, boardId: b.id, access: 'write' });
    const { ticketId } = await call(owner, 'ticketCreate', { boardId: b.id, title: 'T' });
    const s = await driveUpload(
      owner,
      { bucketId, purpose: 'attach', boardId: b.id, name: 'x.png' },
      new Uint8Array([1]),
    );
    const bad = await callRaw(owner, 'messagePost', {
      boardId: b.id,
      ticketId,
      clientId: uniq('c'),
      body: doc('files'),
      bucketUploads: [{ bucketId, path: '../nope', storagePath: s.storagePath }],
    });
    expect(bad.status).toBe(400);
    expect(await ports().files.stat(s.storagePath)).toBeNull();
  });

  inProcess('server-side bytes (the API upload) go straight to Drive too', async () => {
    const { owner } = await people('owner');
    await connect(owner);
    const b = await seedBoard({ admin: owner });
    const bucketId = await driveBucket(owner, 'Ticket files');
    await call(owner, 'bucketGrantSet', { bucketId, boardId: b.id, access: 'write' });
    await call(owner, 'boardAttachBucketSet', {
      boardId: b.id,
      attachBucket: { bucketId, template: 'tickets/<ticketId>/<filename>' },
    });
    const { ticketId, key } = await call(owner, 'ticketCreate', { boardId: b.id, title: 'T' });
    const board = (await db().doc(paths.board(b.id)).get()).data() as Board;
    const { storeBoardFile, withUploads, planBucketUploads, stageBucketUploads } =
      await import('../../src/bucket/attach.js');
    const { runTx } = await import('../../src/runtime/tx.js');
    const up = await storeBoardFile(
      { ids: ports().ids, now: Date.now(), actor: owner.uid },
      { ...board, id: b.id },
      key,
      { name: 'log.txt', mime: 'text/plain', bytes: new TextEncoder().encode('hi') },
    );
    expect(up.storagePath.startsWith(`drive/${bucketId}/`)).toBe(true);
    const staged = await stageBucketUploads([up]);
    await withUploads(staged, () =>
      runTx(async (tx) => {
        const plan = await planBucketUploads(
          tx,
          { actor: owner.uid, ids: ports().ids, now: Date.now() },
          staged,
          b.id,
          key,
        );
        plan.write(tx);
      }),
    );
    expect(paths_((await call(owner, 'bucketTree', { bucketId })).nodes)).toEqual([
      'tickets',
      `tickets/${key}`,
      `tickets/${key}/log.txt`,
    ]);
    expect(ticketId).toBeTruthy();
    expect(await ourObjects(bucketId)).toBe(0);
  });
});

describe('moving a bucket between storages (§K6)', () => {
  inProcess(
    'managed → Drive: files copied, managed copy gone, old ids still open, read-only meanwhile',
    async () => {
      const { owner } = await people('owner');
      await connect(owner);
      const { bucketId } = await call(owner, 'bucketCreate', { name: 'Moving' });
      const a = await call(owner, 'bucketFileWrite', { bucketId, path: 'docs/a.md', text: '# A' });
      await call(owner, 'bucketFileWrite', { bucketId, path: 'b.txt', text: 'bee' });
      expect(await firestoreNodes(bucketId)).toBe(3);

      const started = await call(owner, 'bucketStorageMove', {
        bucketId,
        to: { kind: 'drive', folderPath: 'Moves/Moving' },
      });
      expect(started.total).toBe(3);
      expect((await memDoc(bucketId))!.move).toMatchObject({ state: 'running', to: 'drive' });
      const refused = await callRaw(owner, 'bucketFileWrite', {
        bucketId,
        path: 'c.txt',
        text: 'x',
      });
      expect(refused.status).toBe(409);
      // Reads still work, from where it was.
      expect((await call(owner, 'bucketFileRead', { bucketId, path: 'b.txt' })).text).toBe('bee');

      await queue().drain({ queue: 'bucketStorageMove' });
      const m = (await memDoc(bucketId))!;
      expect(m.move).toBeUndefined();
      expect(m.storage).toMatchObject({ kind: 'drive', folderName: 'Moving' });
      expect(await firestoreNodes(bucketId)).toBe(0);
      expect(await ourObjects(bucketId)).toBe(0);
      expect(paths_((await call(owner, 'bucketTree', { bucketId })).nodes)).toEqual([
        'b.txt',
        'docs',
        'docs/a.md',
      ]);
      // The old (managed) node id still opens the file — ticket links keep working.
      const byOld = await call(owner, 'bucketFileRead', { bucketId, nodeId: a.nodeId });
      expect(byOld.text).toBe('# A');
      // Writable again, now in Drive.
      await call(owner, 'bucketFileWrite', { bucketId, path: 'c.txt', text: 'sea' });
    },
  );

  inProcess(
    'Drive → managed: nodes keep the Drive ids, bytes are ours, the Drive folder stays',
    async () => {
      const { owner } = await people('owner');
      await connect(owner);
      const bucketId = await driveBucket(owner, 'Back home');
      const w = await call(owner, 'bucketFileWrite', {
        bucketId,
        path: 'notes/n.md',
        text: 'note',
      });
      await call(owner, 'bucketStorageMove', { bucketId, to: { kind: 'managed' } });
      await queue().drain({ queue: 'bucketStorageMove' });
      const m = (await memDoc(bucketId))!;
      expect(m.storage).toBeUndefined();
      expect(m.move).toBeUndefined();
      expect(m.stats).toEqual({ files: 1, folders: 1, bytes: 4 });
      expect(await firestoreNodes(bucketId)).toBe(2);
      const read = await call(owner, 'bucketFileRead', { bucketId, nodeId: w.nodeId });
      expect(read.text).toBe('note');
      expect(await ourObjects(bucketId)).toBe(1);
      const again = await callRaw(owner, 'bucketStorageMove', {
        bucketId,
        to: { kind: 'managed' },
      });
      expect(again.status).toBe(400);
    },
  );

  inProcess('only the owner moves; an editor is refused', async () => {
    const { owner, ed } = await people('owner', 'ed');
    await connect(owner);
    await connect(ed);
    const { bucketId } = await call(owner, 'bucketCreate', { name: 'Mine' });
    await call(owner, 'bucketShare', { bucketId, email: ed.email, role: 'editor' });
    const r = await callRaw(ed, 'bucketStorageMove', { bucketId, to: { kind: 'drive' } });
    expect(r.status).toBe(403);
  });

  inProcess('a stopped move resumes: same target, nothing copied twice', async () => {
    const { owner } = await people('owner');
    await connect(owner);
    const { bucketId } = await call(owner, 'bucketCreate', { name: 'Stops' });
    for (const n of ['a', 'b', 'c'])
      await call(owner, 'bucketFileWrite', { bucketId, path: `x/${n}.txt`, text: n });
    await call(owner, 'bucketStorageMove', {
      bucketId,
      to: { kind: 'drive', folderPath: 'Stops' },
    });
    // As if a slice had died for good (the queue gave up).
    await db()
      .doc(paths.bucket(bucketId))
      .update({ 'move.state': 'failed', 'move.error': 'terminated' });
    await queue().drain({ queue: 'bucketStorageMove' }); // nothing runs for a stopped move
    expect((await memDoc(bucketId))!.move).toMatchObject({ state: 'failed' });
    const r = await call(owner, 'bucketStorageMove', { bucketId, resume: true });
    expect(r.total).toBe(4);
    await queue().drain({ queue: 'bucketStorageMove' });
    const m = (await memDoc(bucketId))!;
    expect(m.move).toBeUndefined();
    expect(m.storage).toMatchObject({ kind: 'drive', folderName: 'Stops' });
    expect(paths_((await call(owner, 'bucketTree', { bucketId })).nodes)).toEqual([
      'x',
      'x/a.txt',
      'x/b.txt',
      'x/c.txt',
    ]);
    const none = await callRaw(owner, 'bucketStorageMove', { bucketId, resume: true });
    expect(none.status).toBe(409);
  });
});

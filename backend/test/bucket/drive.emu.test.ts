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
import { paths, type Bucket } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { fakeDriveTouch } from '../../src/bucket/drive/api.js';
import {
  call,
  callRaw,
  ports,
  request,
  setupEmulators,
  uniq,
  type TestUser,
} from '../harness/index.js';
import { doc, people, putBucketObject, seedBoard } from '../tickets/helpers.js';

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
    // The counters follow the last full listing.
    expect((await memDoc(bucketId))!.stats).toEqual({ files: 1, folders: 3, bytes: 7 });

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

describe('Drive bucket files on tickets (§K3, §K4)', () => {
  inProcess('an app upload is staged, then moved into Drive; the staging copy goes', async () => {
    const { owner } = await people('owner');
    await connect(owner);
    const bucketId = await driveBucket(owner);
    const files = ports().files;
    const up = await putBucketObject(files, bucketId, 'pic.png', new Uint8Array([9, 8, 7]));
    const put = await call(owner, 'bucketFilePut', {
      bucketId,
      path: 'img/pic.png',
      storagePath: up.storagePath,
    });
    expect(await files.stat(up.storagePath)).toBeNull();
    const read = await call(owner, 'bucketFileRead', { bucketId, nodeId: put.nodeId });
    expect(read.node.file).toMatchObject({ mime: 'image/png', size: 3 });
    const bytes = await request(read.bytesUrl.replace(/^\/api/, '/api'));
    expect(bytes.status).toBe(200);
  });

  inProcess(
    "ticket files: planned in the transaction, placed in Drive after it; '<ticketId>' filled",
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
      const files = ports().files;
      const s1 = await putBucketObject(files, bucketId, 'shot.png');
      const s2 = await putBucketObject(files, bucketId, 'shot.png');
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
      expect(await files.stat(s1.storagePath)).toBeNull();

      // The ticket's reference opens through the file door, and follows a move.
      const ticket = (await db().doc(paths.ticket(b.id, ticketId)).get()).data() as {
        files: { path: string; bucket?: { nodeId: string } }[];
      };
      const ref = ticket.files.find((f) => f.bucket)!;
      const open = await request(`/api/files/url?path=${encodeURIComponent(ref.path)}`, {
        headers: { authorization: `Bearer ${com.token}` },
      });
      expect(open.status).toBe(200);
      await call(owner, 'bucketMove', {
        bucketId,
        nodeId: ref.bucket!.nodeId,
        toPath: 'moved.png',
      });
      const again = await request(`/api/files/url?path=${encodeURIComponent(ref.path)}`, {
        headers: { authorization: `Bearer ${com.token}` },
      });
      expect(again.status).toBe(200);
    },
  );
});

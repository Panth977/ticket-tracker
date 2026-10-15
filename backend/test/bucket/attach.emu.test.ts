/**
 * TICKET ATTACHMENTS LIVE IN A BUCKET (docs/plan/bucket.html §J), on the emulators:
 *
 *   bucketUploads   a commenter (no role on the bucket) adds a NEW file to a
 *                   bucket granted write; '<ticketId>' filled; a taken path
 *                   gets ' (2)'; a read grant / a file parent is refused
 *   attachments     retired: a non-empty list is a 400
 *   boardAttachBucketSet   admin only, write grant only; cleared when the
 *                   grant goes or the bucket is deleted
 *   API uploads     land in the default bucket; post_message's fileIds work;
 *                   housekeeping never deletes the bucket's object
 */
import { describe, expect, it } from 'vitest';
import { paths, type Board, type Bucket, type BucketNode, type Ticket } from '@tm/shared';
import { pruneUploads } from '../../src/notify/housekeeping.js';
import { db } from '../../src/runtime/firebase.js';
import { storeUploadedFile } from '../../src/tickets/files.js';
import { makeCtx } from '../../src/runtime/context.js';
import { call, ports, setupEmulators, uniq, type TestUser } from '../harness/index.js';
import {
  doc,
  getDocData,
  people,
  putBucketObject,
  seedAttachBucket,
  seedBoard,
} from '../tickets/helpers.js';

setupEmulators();

const inProcess = it.skipIf(!!process.env.TM_API_URL);
const D = 24 * 60 * 60 * 1000;
const nodes = async (bucketId: string) =>
  (await db().collection(paths.bucketNodes(bucketId)).get()).docs
    .map((d) => ({ id: d.id, ...(d.data() as BucketNode) }))
    .sort((a, b) => a.path.localeCompare(b.path));
const boardOf = (id: string) => getDocData<Board>(paths.board(id)).then((b) => b!);
const ticketOf = (b: string, t: string) => getDocData<Ticket>(paths.ticket(b, t)).then((x) => x!);

const post = (
  u: TestUser,
  boardId: string,
  ticketId: string,
  bucketUploads: { bucketId: string; path: string; storagePath: string }[],
) =>
  call(u, 'messagePost', {
    boardId,
    ticketId,
    clientId: uniq('c'),
    body: doc('files'),
    bucketUploads,
  });

describe('bucketUploads (§J)', () => {
  inProcess(
    "a commenter adds NEW files to a bucket granted write: '<ticketId>' filled, a taken path numbered",
    async () => {
      const { owner, com } = await people('owner', 'com');
      const b = await seedBoard({ admin: owner, commenters: [com] });
      const bucketId = await seedAttachBucket(b.id, owner);
      const { ticketId, key } = await call(owner, 'ticketCreate', {
        boardId: b.id,
        title: 'Shots',
      });
      const files = ports().files;
      const a = await putBucketObject(files, bucketId, 'shot.png');
      const c = await putBucketObject(files, bucketId, 'shot.png');
      const d = await putBucketObject(files, bucketId, 'shot.png');

      // Two in one message to the same path: both kept, the second numbered.
      await post(com, b.id, ticketId, [
        { bucketId, path: 'tickets/<ticketId>/shot.png', storagePath: a.storagePath },
        { bucketId, path: 'tickets/<ticketId>/shot.png', storagePath: c.storagePath },
      ]);
      // And again later: never replaces, takes the next number.
      await post(com, b.id, ticketId, [
        { bucketId, path: `tickets/${key}/shot.png`, storagePath: d.storagePath },
      ]);
      const files3 = (await nodes(bucketId)).filter((n) => n.kind === 'file');
      expect(files3.map((n) => [n.path, n.file!.fileId])).toEqual([
        [`tickets/${key}/shot (2).png`, c.fileId],
        [`tickets/${key}/shot (3).png`, d.fileId],
        [`tickets/${key}/shot.png`, a.fileId],
      ]);
      expect(files3.every((n) => n.createdBy === com.uid)).toBe(true);
      const mem = (await getDocData<Bucket>(paths.bucket(bucketId)))!;
      expect(mem.stats).toEqual({ files: 3, folders: 2, bytes: 12 });

      const t = await ticketOf(b.id, ticketId);
      expect(t.counts.files).toBe(3);
      // The ticket shows each file's own name; the bucket numbers its nodes.
      expect((t.files ?? []).map((f) => [f.source, f.name])).toEqual([
        ['bucket', 'shot.png'],
        ['bucket', 'shot.png'],
        ['bucket', 'shot.png'],
      ]);
    },
  );

  inProcess(
    'refused: a read grant, a parent that is a file, a viewer; the upload is removed',
    async () => {
      const { owner, com, view } = await people('owner', 'com', 'view');
      const b = await seedBoard({ admin: owner, commenters: [com], viewers: [view] });
      const readOnly = await seedAttachBucket(b.id, owner, { access: 'read' });
      const writable = await seedAttachBucket(b.id, owner);
      const { ticketId } = await call(owner, 'ticketCreate', { boardId: b.id, title: 'x' });
      const files = ports().files;

      const r = await putBucketObject(files, readOnly, 'a.png');
      await expect(
        post(com, b.id, ticketId, [
          { bucketId: readOnly, path: 'a.png', storagePath: r.storagePath },
        ]),
      ).rejects.toMatchObject({ code: 'invalid', details: { field: 'bucketUploads' } });
      expect(await files.stat(r.storagePath)).toBeNull();

      // A file named 'docs' already: 'docs/a.png' cannot be made.
      const first = await putBucketObject(files, writable, 'docs');
      await post(com, b.id, ticketId, [
        { bucketId: writable, path: 'docs', storagePath: first.storagePath },
      ]);
      const w = await putBucketObject(files, writable, 'a.png');
      await expect(
        post(com, b.id, ticketId, [
          { bucketId: writable, path: 'docs/a.png', storagePath: w.storagePath },
        ]),
      ).rejects.toMatchObject({ code: 'invalid' });
      expect(await files.stat(w.storagePath)).toBeNull();

      // A viewer may not post at all — refused before the upload is touched.
      const v = await putBucketObject(files, writable, 'v.png');
      await expect(
        post(view, b.id, ticketId, [
          { bucketId: writable, path: 'v.png', storagePath: v.storagePath },
        ]),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect(await files.stat(v.storagePath)).not.toBeNull();
    },
  );

  it('attachments (board storage paths) are retired', async () => {
    const { owner } = await people('owner');
    const b = await seedBoard({ admin: owner });
    const { ticketId } = await call(owner, 'ticketCreate', { boardId: b.id, title: 'x' });
    await expect(
      call(owner, 'messagePost', {
        boardId: b.id,
        ticketId,
        clientId: uniq('c'),
        body: doc('see'),
        attachments: [`boards/${b.id}/tickets/${ticketId}/a1/x.png`],
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('Files go into a bucket now'),
    });
  });
});

describe('boardAttachBucketSet (§J)', () => {
  it('admin only, a write grant only; cleared when the grant goes or the bucket is deleted', async () => {
    const { owner, ed } = await people('owner', 'ed');
    const b = await seedBoard({ admin: owner, editors: [ed] });
    const { bucketId } = await call(owner, 'bucketCreate', { name: 'Shots' });
    const attachBucket = { bucketId, template: 'shots/<ticketId>/<filename>' };

    // Not granted yet → refused.
    await expect(
      call(owner, 'boardAttachBucketSet', { boardId: b.id, attachBucket }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await call(owner, 'bucketGrantSet', { bucketId, boardId: b.id, access: 'read' });
    await expect(
      call(owner, 'boardAttachBucketSet', { boardId: b.id, attachBucket }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await call(owner, 'bucketGrantSet', { bucketId, boardId: b.id, access: 'write' });
    await expect(
      call(ed, 'boardAttachBucketSet', { boardId: b.id, attachBucket }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // A template must be a usable path with known variables.
    await expect(
      call(owner, 'boardAttachBucketSet', {
        boardId: b.id,
        attachBucket: { bucketId, template: 'x/<nope>' },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });

    await call(owner, 'boardAttachBucketSet', { boardId: b.id, attachBucket });
    expect((await boardOf(b.id)).attachBucket).toEqual(attachBucket);

    // Lowered to read → the default goes with it.
    await call(owner, 'bucketGrantSet', { bucketId, boardId: b.id, access: 'read' });
    expect((await boardOf(b.id)).attachBucket).toBeNull();

    await call(owner, 'bucketGrantSet', { bucketId, boardId: b.id, access: 'write' });
    await call(owner, 'boardAttachBucketSet', { boardId: b.id, attachBucket });
    await call(owner, 'bucketGrantSet', { bucketId, boardId: b.id, access: null });
    expect((await boardOf(b.id)).attachBucket).toBeNull();

    await call(owner, 'bucketGrantSet', { bucketId, boardId: b.id, access: 'write' });
    await call(owner, 'boardAttachBucketSet', { boardId: b.id, attachBucket });
    await call(owner, 'boardAttachBucketSet', { boardId: b.id, attachBucket: null });
    expect((await boardOf(b.id)).attachBucket).toBeNull();

    await call(owner, 'boardAttachBucketSet', { boardId: b.id, attachBucket });
    await call(owner, 'bucketDelete', { bucketId });
    expect((await boardOf(b.id)).attachBucket).toBeNull();
  });
});

describe('API uploads (§J)', () => {
  inProcess(
    'go into the default bucket; fileIds attach them; housekeeping never deletes them',
    async () => {
      const { owner } = await people('owner');
      const b = await seedBoard({ admin: owner });
      const bucketId = await seedAttachBucket(b.id, owner);
      const { ticketId, key } = await call(owner, 'ticketCreate', { boardId: b.id, title: 'x' });
      const ctx = makeCtx({ actor: owner.uid, via: 'api', scopes: ['files:write'] });
      const up = await storeUploadedFile(ctx, {
        boardId: b.id,
        ticketId,
        name: 'log.txt',
        data: new TextEncoder().encode('hello'),
      });
      const node = (await nodes(bucketId)).find((n) => n.id === up.bucket.nodeId)!;
      expect(node.path).toMatch(new RegExp(`^tickets/${key}/\\d{8}-\\d{6}_log\\.txt$`));
      // The bucket node is templated; the ticket shows the file's own name.
      expect(up.name).toBe('log.txt');

      // Unattached for days: the sweep looks at boards/ only.
      await pruneUploads(Date.now() + 3 * D);
      expect(await ports().files.stat(up.objectPath)).not.toBeNull();
      expect((await ticketOf(b.id, ticketId)).files!.map((f) => f.id)).toEqual([up.fileId]);

      const { messageId } = await call(owner, 'messagePost', {
        boardId: b.id,
        ticketId,
        clientId: uniq('c'),
        body: doc('log'),
        fileIds: [up.fileId],
      });
      const t = await ticketOf(b.id, ticketId);
      expect(t.files![0]).toMatchObject({
        id: up.fileId,
        source: 'message',
        messageId,
        bucket: up.bucket,
      });

      // Deleting the message keeps the bucket's file.
      await call(owner, 'messageEdit', { boardId: b.id, ticketId, messageId, delete: true });
      expect(await ports().files.stat(up.objectPath)).not.toBeNull();
    },
  );
});

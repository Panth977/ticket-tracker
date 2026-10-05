/**
 * TICKET ATTACHMENTS LIVE IN A MEMORY (docs/plan/memory.html §J), on the emulators:
 *
 *   memoryUploads   a commenter (no role on the memory) adds a NEW file to a
 *                   memory granted write; '<ticketId>' filled; a taken path
 *                   gets ' (2)'; a read grant / a file parent is refused
 *   attachments     retired: a non-empty list is a 400
 *   boardAttachMemorySet   admin only, write grant only; cleared when the
 *                   grant goes or the memory is deleted
 *   API uploads     land in the default memory; post_message's fileIds work;
 *                   housekeeping never deletes the memory's object
 */
import { describe, expect, it } from 'vitest';
import { paths, type Board, type Memory, type MemoryNode, type Ticket } from '@tm/shared';
import { pruneUploads } from '../../src/notify/housekeeping.js';
import { db } from '../../src/runtime/firebase.js';
import { storeUploadedFile } from '../../src/tickets/files.js';
import { makeCtx } from '../../src/runtime/context.js';
import { call, ports, setupEmulators, uniq, type TestUser } from '../harness/index.js';
import {
  doc,
  getDocData,
  people,
  putMemoryObject,
  seedAttachMemory,
  seedBoard,
} from '../tickets/helpers.js';

setupEmulators();

const inProcess = it.skipIf(!!process.env.TM_API_URL);
const D = 24 * 60 * 60 * 1000;
const nodes = async (memoryId: string) =>
  (await db().collection(paths.memoryNodes(memoryId)).get()).docs
    .map((d) => ({ id: d.id, ...(d.data() as MemoryNode) }))
    .sort((a, b) => a.path.localeCompare(b.path));
const boardOf = (id: string) => getDocData<Board>(paths.board(id)).then((b) => b!);
const ticketOf = (b: string, t: string) => getDocData<Ticket>(paths.ticket(b, t)).then((x) => x!);

const post = (
  u: TestUser,
  boardId: string,
  ticketId: string,
  memoryUploads: { memoryId: string; path: string; storagePath: string }[],
) =>
  call(u, 'messagePost', {
    boardId,
    ticketId,
    clientId: uniq('c'),
    body: doc('files'),
    memoryUploads,
  });

describe('memoryUploads (§J)', () => {
  inProcess(
    "a commenter adds NEW files to a memory granted write: '<ticketId>' filled, a taken path numbered",
    async () => {
      const { owner, com } = await people('owner', 'com');
      const b = await seedBoard({ admin: owner, commenters: [com] });
      const memoryId = await seedAttachMemory(b.id, owner);
      const { ticketId, key } = await call(owner, 'ticketCreate', {
        boardId: b.id,
        title: 'Shots',
      });
      const files = ports().files;
      const a = await putMemoryObject(files, memoryId, 'shot.png');
      const c = await putMemoryObject(files, memoryId, 'shot.png');
      const d = await putMemoryObject(files, memoryId, 'shot.png');

      // Two in one message to the same path: both kept, the second numbered.
      await post(com, b.id, ticketId, [
        { memoryId, path: 'tickets/<ticketId>/shot.png', storagePath: a.storagePath },
        { memoryId, path: 'tickets/<ticketId>/shot.png', storagePath: c.storagePath },
      ]);
      // And again later: never replaces, takes the next number.
      await post(com, b.id, ticketId, [
        { memoryId, path: `tickets/${key}/shot.png`, storagePath: d.storagePath },
      ]);
      const files3 = (await nodes(memoryId)).filter((n) => n.kind === 'file');
      expect(files3.map((n) => [n.path, n.file!.fileId])).toEqual([
        [`tickets/${key}/shot (2).png`, c.fileId],
        [`tickets/${key}/shot (3).png`, d.fileId],
        [`tickets/${key}/shot.png`, a.fileId],
      ]);
      expect(files3.every((n) => n.createdBy === com.uid)).toBe(true);
      const mem = (await getDocData<Memory>(paths.memory(memoryId)))!;
      expect(mem.stats).toEqual({ files: 3, folders: 2, bytes: 12 });

      const t = await ticketOf(b.id, ticketId);
      expect(t.counts.files).toBe(3);
      // The ticket shows each file's own name; the memory numbers its nodes.
      expect((t.files ?? []).map((f) => [f.source, f.name])).toEqual([
        ['memory', 'shot.png'],
        ['memory', 'shot.png'],
        ['memory', 'shot.png'],
      ]);
    },
  );

  inProcess(
    'refused: a read grant, a parent that is a file, a viewer; the upload is removed',
    async () => {
      const { owner, com, view } = await people('owner', 'com', 'view');
      const b = await seedBoard({ admin: owner, commenters: [com], viewers: [view] });
      const readOnly = await seedAttachMemory(b.id, owner, { access: 'read' });
      const writable = await seedAttachMemory(b.id, owner);
      const { ticketId } = await call(owner, 'ticketCreate', { boardId: b.id, title: 'x' });
      const files = ports().files;

      const r = await putMemoryObject(files, readOnly, 'a.png');
      await expect(
        post(com, b.id, ticketId, [
          { memoryId: readOnly, path: 'a.png', storagePath: r.storagePath },
        ]),
      ).rejects.toMatchObject({ code: 'invalid', details: { field: 'memoryUploads' } });
      expect(await files.stat(r.storagePath)).toBeNull();

      // A file named 'docs' already: 'docs/a.png' cannot be made.
      const first = await putMemoryObject(files, writable, 'docs');
      await post(com, b.id, ticketId, [
        { memoryId: writable, path: 'docs', storagePath: first.storagePath },
      ]);
      const w = await putMemoryObject(files, writable, 'a.png');
      await expect(
        post(com, b.id, ticketId, [
          { memoryId: writable, path: 'docs/a.png', storagePath: w.storagePath },
        ]),
      ).rejects.toMatchObject({ code: 'invalid' });
      expect(await files.stat(w.storagePath)).toBeNull();

      // A viewer may not post at all — refused before the upload is touched.
      const v = await putMemoryObject(files, writable, 'v.png');
      await expect(
        post(view, b.id, ticketId, [
          { memoryId: writable, path: 'v.png', storagePath: v.storagePath },
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
      message: expect.stringContaining('Files go into a memory now'),
    });
  });
});

describe('boardAttachMemorySet (§J)', () => {
  it('admin only, a write grant only; cleared when the grant goes or the memory is deleted', async () => {
    const { owner, ed } = await people('owner', 'ed');
    const b = await seedBoard({ admin: owner, editors: [ed] });
    const { memoryId } = await call(owner, 'memoryCreate', { name: 'Shots' });
    const attachMemory = { memoryId, template: 'shots/<ticketId>/<filename>' };

    // Not granted yet → refused.
    await expect(
      call(owner, 'boardAttachMemorySet', { boardId: b.id, attachMemory }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await call(owner, 'memoryGrantSet', { memoryId, boardId: b.id, access: 'read' });
    await expect(
      call(owner, 'boardAttachMemorySet', { boardId: b.id, attachMemory }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await call(owner, 'memoryGrantSet', { memoryId, boardId: b.id, access: 'write' });
    await expect(
      call(ed, 'boardAttachMemorySet', { boardId: b.id, attachMemory }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // A template must be a usable path with known variables.
    await expect(
      call(owner, 'boardAttachMemorySet', {
        boardId: b.id,
        attachMemory: { memoryId, template: 'x/<nope>' },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });

    await call(owner, 'boardAttachMemorySet', { boardId: b.id, attachMemory });
    expect((await boardOf(b.id)).attachMemory).toEqual(attachMemory);

    // Lowered to read → the default goes with it.
    await call(owner, 'memoryGrantSet', { memoryId, boardId: b.id, access: 'read' });
    expect((await boardOf(b.id)).attachMemory).toBeNull();

    await call(owner, 'memoryGrantSet', { memoryId, boardId: b.id, access: 'write' });
    await call(owner, 'boardAttachMemorySet', { boardId: b.id, attachMemory });
    await call(owner, 'memoryGrantSet', { memoryId, boardId: b.id, access: null });
    expect((await boardOf(b.id)).attachMemory).toBeNull();

    await call(owner, 'memoryGrantSet', { memoryId, boardId: b.id, access: 'write' });
    await call(owner, 'boardAttachMemorySet', { boardId: b.id, attachMemory });
    await call(owner, 'boardAttachMemorySet', { boardId: b.id, attachMemory: null });
    expect((await boardOf(b.id)).attachMemory).toBeNull();

    await call(owner, 'boardAttachMemorySet', { boardId: b.id, attachMemory });
    await call(owner, 'memoryDelete', { memoryId });
    expect((await boardOf(b.id)).attachMemory).toBeNull();
  });
});

describe('API uploads (§J)', () => {
  inProcess(
    'go into the default memory; fileIds attach them; housekeeping never deletes them',
    async () => {
      const { owner } = await people('owner');
      const b = await seedBoard({ admin: owner });
      const memoryId = await seedAttachMemory(b.id, owner);
      const { ticketId, key } = await call(owner, 'ticketCreate', { boardId: b.id, title: 'x' });
      const ctx = makeCtx({ actor: owner.uid, via: 'api', scopes: ['files:write'] });
      const up = await storeUploadedFile(ctx, {
        boardId: b.id,
        ticketId,
        name: 'log.txt',
        data: new TextEncoder().encode('hello'),
      });
      const node = (await nodes(memoryId)).find((n) => n.id === up.memory.nodeId)!;
      expect(node.path).toMatch(new RegExp(`^tickets/${key}/\\d{8}-\\d{6}_log\\.txt$`));
      // The memory node is templated; the ticket shows the file's own name.
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
        memory: up.memory,
      });

      // Deleting the message keeps the memory's file.
      await call(owner, 'messageEdit', { boardId: b.id, ticketId, messageId, delete: true });
      expect(await ports().files.stat(up.objectPath)).not.toBeNull();
    },
  );
});

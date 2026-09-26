import { describe, expect, it } from 'vitest';
import { paths, storage, type BoardMember, type User } from '@tm/shared';
import { auth, db } from '../../src/runtime/firebase.js';
import {
  devOutbox,
  ports,
  queue,
  setPorts,
  memorySearch,
  setupEmulators,
} from '../harness/index.js';
import { NO_BOARDS } from '../../src/commands/searchKey.js';
import { crc32, zip } from '../../src/commands/accountExportJob.js';
import {
  addMember,
  call,
  createUser,
  getBoard,
  getMember,
  newBoard,
  seedTicket,
} from './helpers.js';
import { putMessage } from '../tickets/store.js';

setupEmulators();

const user = async (uid: string) =>
  (await db().doc(paths.user(uid)).get()).data() as User | undefined;
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('profileUpdate', () => {
  it('creates users/ if the trigger has not run, and fans name out to members/', async () => {
    const alice = await createUser({ name: 'Alice' });
    const { boardId } = await newBoard(alice);
    await call(alice, 'profileUpdate', {
      name: 'Alice R',
      timezone: 'Asia/Kolkata',
      theme: 'dark',
    });
    expect(await user(alice.uid)).toMatchObject({
      name: 'Alice R',
      email: alice.email,
      timezone: 'Asia/Kolkata',
      theme: 'dark',
    });
    expect((await getMember(boardId, alice.uid))!.name).toBe('Alice R');
  });

  it('notify: channels merged per event, other keys replace', async () => {
    const u = await createUser();
    await call(u, 'profileUpdate', {
      notify: {
        channels: { comment: ['inApp', 'email'] },
        digest: 'daily',
        quietHours: { start: '22:00', end: '07:00' },
      },
    });
    const n = (await user(u.uid))!.notify;
    expect(n.channels.comment).toEqual(['inApp', 'email']);
    expect(n.channels.mentioned).toEqual(['inApp', 'push', 'email']); // untouched default
    expect(n).toMatchObject({ digest: 'daily', quietHours: { start: '22:00', end: '07:00' } });
  });

  it('avatar: must be ours, exist and be an image; the previous one is deleted; members updated', async () => {
    const u = await createUser();
    const { boardId } = await newBoard(u);
    const files = ports().files;
    const p1 = storage.avatar(u.uid, 1);
    const p2 = storage.avatar(u.uid, 2);
    await files.write(p1, new Uint8Array(PNG_1PX), 'image/png');
    await files.write(p2, new Uint8Array(PNG_1PX), 'image/png');

    await expect(
      call(u, 'profileUpdate', { avatarPath: `users/someone-else/avatar/1.webp` }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      call(u, 'profileUpdate', { avatarPath: storage.avatar(u.uid, 99) }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const txt = `${storage.avatarPrefix(u.uid)}note.txt`;
    await files.write(txt, new Uint8Array(Buffer.from('hi')), 'text/plain');
    await expect(call(u, 'profileUpdate', { avatarPath: txt })).rejects.toMatchObject({
      code: 'invalid',
    });

    await call(u, 'profileUpdate', { avatarPath: p1 });
    expect((await getMember(boardId, u.uid))!.avatarPath).toBe(p1);
    await call(u, 'profileUpdate', { avatarPath: p2 });
    expect(await files.stat(p1)).toBeNull();
    expect((await user(u.uid))!.avatarPath).toBe(p2);
    await call(u, 'profileUpdate', { avatarPath: null });
    expect((await getMember(boardId, u.uid))!.avatarPath).toBeNull();
    expect(await files.stat(p2)).toBeNull();
  });

  it('bad time zone 400; whatsappOptIn without a verified number 400; no email field', async () => {
    const u = await createUser();
    await expect(call(u, 'profileUpdate', { timezone: 'Mars/Olympus' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(call(u, 'profileUpdate', { whatsappOptIn: true })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(call(u, 'profileUpdate', { email: 'x@y.z' } as never)).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

describe('accountDelete', () => {
  it('409 naming boards where they are the only admin among others', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { boardId, key } = await newBoard(alice);
    await addMember(boardId, bob, 'editor');
    await expect(
      call(alice, 'accountDelete', { confirm: 'DELETE', recentLogin: true }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { boards: [{ boardId, key, name: 'Engineering' }] },
    });
    expect((await getBoard(boardId))!.access[alice.uid]).toBe('admin'); // nothing changed
  });

  it('solo boards deleted, other boards left, profile soft-deleted, auth account gone', async () => {
    const alice = await createUser({ name: 'Alice' });
    const bob = await createUser();
    const solo = await newBoard(alice);
    const shared = await newBoard(bob);
    await addMember(shared.boardId, alice, 'editor');
    const stageId = (await getBoard(shared.boardId))!.stages[0]!.id;
    const t = await seedTicket(shared.boardId, { stageId, assigneeUids: [alice.uid] });
    await db()
      .doc(paths.device(alice.uid, 'd1'))
      .set({ fcmToken: 'x', kind: 'web', userAgent: 'ua', lastSeenAt: 1 });

    await call(alice, 'accountDelete', { confirm: 'DELETE', recentLogin: true });

    expect(await getBoard(solo.boardId)).toBeUndefined();
    expect((await db().doc(paths.boardKey(solo.key)).get()).data()).toMatchObject({
      deleted: true,
    });
    expect(
      queue()
        .pending()
        .some((p) => p.queue === 'boardDelete'),
    ).toBe(true);
    const sb = (await getBoard(shared.boardId))!;
    expect(sb.readerUids).toEqual([bob.uid]);
    expect(await getMember(shared.boardId, alice.uid)).toBeUndefined();
    expect((await db().doc(paths.ticket(shared.boardId, t)).get()).get('assigneeUids')).toEqual([]);
    expect(await user(alice.uid)).toMatchObject({
      name: 'Deleted user',
      email: '',
      avatarPath: null,
      deletedAt: expect.any(Number),
    });
    expect((await db().collection(paths.devices(alice.uid)).get()).size).toBe(0);
    await expect(auth().getUser(alice.uid)).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });

  it('requires the literal confirmations', async () => {
    const u = await createUser();
    await expect(
      call(u, 'accountDelete', { confirm: 'yes', recentLogin: true } as never),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

describe('accountExport', () => {
  it('queues a job; the job zips profile/tickets/messages to Storage and mails a signed URL', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const stageId = (await getBoard(boardId))!.stages[0]!.id;
    const t = await seedTicket(boardId, { stageId, createdBy: alice.uid, title: 'Mine' });
    const path = `boards/${boardId}/tickets/${t}/att1/notes.txt`;
    await ports().files.write(path, new Uint8Array(Buffer.from('file body')), 'text/plain');
    await putMessage(boardId, t, 'm1', {
      kind: 'comment',
      body: { doc: { type: 'doc', content: [] }, text: 'hello', mentions: [], refs: [] },
      authorUid: alice.uid,
      authorName: 'Alice',
      via: 'app',
      replyTo: null,
      attachments: [
        { id: 'att1', path, name: 'notes.txt', mime: 'text/plain', size: 9, uploadedBy: alice.uid },
      ],
      reactions: {},
      pinnedAt: null,
      pinnedBy: null,
      editedAt: null,
      deletedAt: null,
      createdAt: 1,
    });

    const { jobId } = await call(alice, 'accountExport', {});
    expect(queue().pending()).toEqual([
      expect.objectContaining({ queue: 'export', payload: { jobId, uid: alice.uid } }),
    ]);
    await queue().drain({ queue: 'export' });

    const obj = await ports().files.stat(storage.export(alice.uid, jobId));
    expect(obj).toMatchObject({ contentType: 'application/zip' });
    const bytes = Buffer.from(await ports().files.read(storage.export(alice.uid, jobId)));
    const text = bytes.toString('latin1');
    expect(text).toContain('profile.json');
    expect(text).toContain('"title": "Mine"');
    expect(text).toContain('"text": "hello"');
    expect(text).toContain('file body');
    const mail = await devOutbox<{ text: string; tag: string }>('mail', {
      field: 'to',
      equals: alice.email,
    });
    expect(mail.at(-1)).toMatchObject({ tag: 'export' });
    expect(mail.at(-1)!.text).toContain(jobId);
  });

  it('zip writer produces a valid archive structure', () => {
    const z = Buffer.from(zip([{ name: 'a.txt', data: new Uint8Array(Buffer.from('abc')) }]));
    expect(z.readUInt32LE(0)).toBe(0x04034b50);
    expect(z.readUInt32LE(14)).toBe(crc32(new Uint8Array(Buffer.from('abc'))));
    expect(crc32(new Uint8Array(Buffer.from('123456789')))).toBe(0xcbf43926);
    expect(z.readUInt32LE(z.length - 22)).toBe(0x06054b50);
  });
});

describe('searchKey', () => {
  it('scopes the key to boards the caller reads, valid 1h', async () => {
    const search = memorySearch();
    setPorts({ search });
    const alice = await createUser();
    const bob = await createUser();
    const a = await newBoard(alice);
    const b = await newBoard(bob);
    await addMember(b.boardId, alice, 'viewer');
    await newBoard(bob); // not alice's
    const res = await call(alice, 'searchKey', {});
    expect(res.host).toBe('memory');
    const scope = JSON.parse(Buffer.from(res.key.slice(4), 'base64url').toString()) as {
      boardIds: string[];
      expiresAt: number;
    };
    expect(scope.boardIds.sort()).toEqual([a.boardId, b.boardId].sort());
    expect(res.expiresAt).toBe(scope.expiresAt);
    expect(res.expiresAt - Date.now()).toBeGreaterThan(59 * 60 * 1000);

    const loner = await createUser();
    const r2 = await call(loner, 'searchKey', {});
    expect(JSON.parse(Buffer.from(r2.key.slice(4), 'base64url').toString()).boardIds).toEqual([
      NO_BOARDS,
    ]);
  });

  it('503 when the search backend fails', async () => {
    setPorts({
      search: { ...memorySearch(), scopedKey: async () => Promise.reject(new Error('down')) },
    });
    const u = await createUser();
    const orig = console.warn;
    console.warn = () => {};
    await expect(call(u, 'searchKey', {})).rejects.toMatchObject({ code: 'unavailable' });
    console.warn = orig;
  });
});

export type { BoardMember };

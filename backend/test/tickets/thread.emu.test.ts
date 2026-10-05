/** ticketWatch, reads pointer, messagePost / Edit / Pin / React under the emulators. */
import { describe, expect, it } from 'vitest';
import { paths, type BoardPref, type Read, type Ticket } from '@tm/shared';
import { call, fixedClock, setPorts, setupEmulators, uniq } from '../harness/index.js';
import {
  doc,
  getDocData,
  people,
  putMemoryObject,
  seedAttachMemory,
  seedBoard,
  spyPorts,
} from './helpers.js';
import { filesOf, msgOf, msgsOf } from './store.js';

setupEmulators();

const T = (b: string, t: string) => getDocData<Ticket>(paths.ticket(b, t)).then((x) => x!);
const M = (b: string, t: string, m: string) => msgOf(b, t, m).then((x) => x!);

describe('ticketWatch', () => {
  it('watcherUids ± actor and prefs.watching ± ticket (prefs created with defaults)', async () => {
    spyPorts();
    const { asha, vic, out } = await people('asha', 'vic', 'out');
    const b = await seedBoard({ admin: asha, viewers: [vic] });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });

    await call(vic, 'ticketWatch', { boardId: b.id, ticketId, watching: true });
    expect((await T(b.id, ticketId)).watcherUids).toEqual([asha.uid, vic.uid]);
    expect(await getDocData<BoardPref>(paths.pref(b.id, vic.uid))).toMatchObject({
      mode: 'mine',
      watching: [ticketId],
    });

    await call(vic, 'ticketWatch', { boardId: b.id, ticketId, watching: false });
    expect((await T(b.id, ticketId)).watcherUids).toEqual([asha.uid]);
    expect((await getDocData<BoardPref>(paths.pref(b.id, vic.uid)))!.watching).toEqual([]);

    await expect(
      call(out, 'ticketWatch', { boardId: b.id, ticketId, watching: true }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      call(vic, 'ticketWatch', { boardId: b.id, ticketId: 'nope', watching: true }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('messagePost', () => {
  it('posts, counts, marks the author read, watches, notifies mentioned then the rest', async () => {
    const s = spyPorts();
    setPorts({ clock: fixedClock(1_750_000_000_000) });
    const { asha, priya, cora, out } = await people('asha', 'priya', 'cora', 'out');
    const b = await seedBoard({ admin: asha, editors: [priya], commenters: [cora] });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });
    const clientId = uniq('c');
    // memory.html §J: the file goes into the board's memory (cora has no role on it).
    const memoryId = await seedAttachMemory(b.id, asha);
    const up = await putMemoryObject(
      s.files,
      memoryId,
      'log.txt',
      new Uint8Array(42),
      'text/plain',
    );
    s.notified.length = 0;

    const r = await call(cora, 'messagePost', {
      boardId: b.id,
      ticketId,
      clientId,
      body: doc('hey ', { uid: priya.uid }, ' and ', { uid: out.uid }),
      memoryUploads: [
        { memoryId, path: 'tickets/<ticketId>/log.txt', storagePath: up.storagePath },
      ],
    });
    expect(r.messageId).toBe(clientId); // the optimistic bubble's id

    const m = await M(b.id, ticketId, r.messageId);
    expect(m).toMatchObject({
      kind: 'comment',
      authorUid: cora.uid,
      authorName: 'cora',
      via: 'app',
      replyTo: null,
      editedAt: null,
    });
    expect(m.body.mentions).toEqual([priya.uid]);
    expect(m.attachments).toEqual([
      expect.objectContaining({
        path: expect.stringMatching(new RegExp(`^memories/${memoryId}/nodes/`)),
        name: 'log.txt',
        size: 42,
        memory: { memoryId, nodeId: expect.any(String) },
      }),
    ]);
    const t = await T(b.id, ticketId);
    expect(t.counts).toEqual({ messages: 1, files: 1, pinned: 0 });
    expect(t.lastMessageAt).toBe(1_750_000_000_000);
    expect(t.watcherUids).toContain(cora.uid);
    expect(await getDocData<Read>(paths.read(cora.uid, ticketId))).toEqual({
      boardId: b.id,
      readAt: 1_750_000_000_000,
      ticketId,
    });
    expect(await filesOf(b.id, ticketId)).toEqual([
      expect.objectContaining({
        id: m.attachments[0]!.id,
        source: 'memory',
        messageId: clientId,
        memory: m.attachments[0]!.memory,
      }),
    ]);

    expect(s.notified.map((n) => n.event)).toEqual(['mentioned', 'comment']);
    expect(s.notified[0]!.extra).toMatchObject({ mentioned: [priya.uid], messageId: clientId });
    expect(s.notified[1]!.extra).toMatchObject({ exclude: [priya.uid], messageId: clientId });
    expect(s.emitted.at(-1)).toMatchObject({
      event: 'message.created',
      data: { id: clientId, body_md: expect.stringContaining('hey') },
    });

    // Replay of the same clientId → one message.
    const again = await call(cora, 'messagePost', {
      boardId: b.id,
      ticketId,
      clientId,
      body: doc('hey'),
    });
    expect(again.messageId).toBe(clientId);
    expect((await T(b.id, ticketId)).counts.messages).toBe(1);

    // replyTo must exist; empty body without files is refused.
    await expect(
      call(cora, 'messagePost', {
        boardId: b.id,
        ticketId,
        clientId: uniq('c'),
        body: doc('x'),
        replyTo: 'nope',
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      call(cora, 'messagePost', {
        boardId: b.id,
        ticketId,
        clientId: uniq('c'),
        body: { type: 'doc', content: [] },
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('closed threads 409; viewers 403; outsiders 404', async () => {
    spyPorts();
    const { asha, vic, out } = await people('asha', 'vic', 'out');
    const b = await seedBoard({ admin: asha, viewers: [vic] });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });
    await expect(
      call(vic, 'messagePost', { boardId: b.id, ticketId, clientId: uniq('c'), body: doc('x') }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(out, 'messagePost', { boardId: b.id, ticketId, clientId: uniq('c'), body: doc('x') }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await call(asha, 'ticketState', { boardId: b.id, ticketId, state: 'archived' });
    await expect(
      call(asha, 'messagePost', { boardId: b.id, ticketId, clientId: uniq('c'), body: doc('x') }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('#refs: backlink + a system line on the referenced ticket, only the first time', async () => {
    spyPorts();
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const src = await call(asha, 'ticketCreate', { boardId: b.id, title: 'src' });
    const tgt = await call(asha, 'ticketCreate', { boardId: b.id, title: 'tgt' });
    const body = doc('see ', { ticketId: tgt.ticketId, key: tgt.key });
    await call(asha, 'messagePost', {
      boardId: b.id,
      ticketId: src.ticketId,
      clientId: uniq('c'),
      body,
    });
    await call(asha, 'messagePost', {
      boardId: b.id,
      ticketId: src.ticketId,
      clientId: uniq('c'),
      body,
    });

    expect((await T(b.id, src.ticketId)).refs).toEqual([tgt.ticketId]);
    const target = await T(b.id, tgt.ticketId);
    expect(target.referencedBy).toEqual([src.ticketId]);
    const lines = (await msgsOf(b.id, tgt.ticketId)).filter((m) => m.kind === 'system');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.body.text).toBe(`Referenced from #${src.key}`);
    expect(target.counts.messages).toBe(1);
  });

  it('refs to boards the author cannot read are not refs', async () => {
    spyPorts();
    const { asha, priya } = await people('asha', 'priya');
    const mine = await seedBoard({ admin: asha, editors: [priya] });
    const secret = await seedBoard({ admin: asha }); // priya is not on it
    const hidden = await call(asha, 'ticketCreate', { boardId: secret.id, title: 'hidden' });
    const t = await call(asha, 'ticketCreate', { boardId: mine.id, title: 't' });
    const r = await call(priya, 'messagePost', {
      boardId: mine.id,
      ticketId: t.ticketId,
      clientId: uniq('c'),
      body: doc('see ', { ticketId: hidden.ticketId, key: hidden.key }),
    });
    expect((await M(mine.id, t.ticketId, r.messageId)).body.refs).toEqual([]);
    expect((await T(secret.id, hidden.ticketId)).referencedBy).toEqual([]);
    // …but asha can read both boards: a cross-board ref works.
    await call(asha, 'messagePost', {
      boardId: mine.id,
      ticketId: t.ticketId,
      clientId: uniq('c'),
      body: doc({ ticketId: hidden.ticketId, key: hidden.key }),
    });
    expect((await T(secret.id, hidden.ticketId)).referencedBy).toEqual([t.ticketId]);
  });
});

describe('messageEdit / messagePin / messageReact', () => {
  it('edit: author only; new mentions notify once; delete: tombstone + files deletedAt', async () => {
    const s = spyPorts();
    const { asha, priya, cora } = await people('asha', 'priya', 'cora');
    const b = await seedBoard({ admin: asha, editors: [priya], commenters: [cora] });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });
    const memoryId = await seedAttachMemory(b.id, asha);
    const up = await putMemoryObject(s.files, memoryId, 'a.png');
    const { messageId } = await call(cora, 'messagePost', {
      boardId: b.id,
      ticketId,
      clientId: uniq('c'),
      body: doc('hi ', { uid: priya.uid }),
      memoryUploads: [{ memoryId, path: 'a.png', storagePath: up.storagePath }],
    });

    s.notified.length = 0;
    await call(cora, 'messageEdit', {
      boardId: b.id,
      ticketId,
      messageId,
      body: doc('hi ', { uid: priya.uid }, ' ', { uid: asha.uid }),
    });
    const m = await M(b.id, ticketId, messageId);
    expect(m.editedAt).toEqual(expect.any(Number));
    expect(m.body.mentions).toEqual([priya.uid, asha.uid]);
    expect(s.notified).toEqual([
      expect.objectContaining({
        event: 'mentioned',
        extra: expect.objectContaining({ mentioned: [asha.uid] }),
      }),
    ]);

    await expect(
      call(asha, 'messageEdit', { boardId: b.id, ticketId, messageId, body: doc('admin edit') }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(priya, 'messageEdit', { boardId: b.id, ticketId, messageId, delete: true }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(cora, 'messageEdit', { boardId: b.id, ticketId, messageId }),
    ).rejects.toMatchObject({ code: 'invalid' });

    await call(asha, 'messagePin', { boardId: b.id, ticketId, messageId, pinned: true });
    await call(asha, 'messageEdit', { boardId: b.id, ticketId, messageId, delete: true }); // admins may delete
    const gone = await M(b.id, ticketId, messageId);
    expect(gone).toMatchObject({
      deletedAt: expect.any(Number),
      attachments: [],
      pinnedAt: null,
      body: { text: '', mentions: [] },
    });
    expect((await filesOf(b.id, ticketId))[0]!.deletedAt).toEqual(expect.any(Number));
    // memory.html §J: the file is the memory's — deleting the message keeps it.
    expect(s.files.has(up.storagePath)).toBe(true);
    const t = await T(b.id, ticketId);
    expect(t.counts).toMatchObject({ files: 0, pinned: 0 });
    await expect(
      call(cora, 'messageEdit', { boardId: b.id, ticketId, messageId, body: doc('again') }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('pin: editor+, counts.pinned, a system line quoting it; react: toggles, no notification', async () => {
    const s = spyPorts();
    const { asha, priya, cora } = await people('asha', 'priya', 'cora');
    const b = await seedBoard({ admin: asha, editors: [priya], commenters: [cora] });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });
    const { messageId } = await call(cora, 'messagePost', {
      boardId: b.id,
      ticketId,
      clientId: uniq('c'),
      body: doc('decision: ship'),
    });

    await expect(
      call(cora, 'messagePin', { boardId: b.id, ticketId, messageId, pinned: true }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await call(priya, 'messagePin', { boardId: b.id, ticketId, messageId, pinned: true });
    await call(priya, 'messagePin', { boardId: b.id, ticketId, messageId, pinned: true }); // no-op
    expect(await M(b.id, ticketId, messageId)).toMatchObject({
      pinnedAt: expect.any(Number),
      pinnedBy: priya.uid,
    });
    expect((await T(b.id, ticketId)).counts.pinned).toBe(1);
    const lines = (await msgsOf(b.id, ticketId)).filter((m) => m.kind === 'system');
    expect(lines).toEqual([expect.objectContaining({ replyTo: messageId })]);
    expect(lines[0]!.body.text).toBe('priya pinned a message');
    expect(s.emitted.at(-1)).toMatchObject({
      event: 'message.pinned',
      data: { id: messageId, pinned: true },
    });
    await call(priya, 'messagePin', { boardId: b.id, ticketId, messageId, pinned: false });
    expect((await T(b.id, ticketId)).counts.pinned).toBe(0);

    s.notified.length = 0;
    await call(cora, 'messageReact', { boardId: b.id, ticketId, messageId, emoji: '👍', on: true });
    await call(asha, 'messageReact', { boardId: b.id, ticketId, messageId, emoji: '👍', on: true });
    await call(asha, 'messageReact', {
      boardId: b.id,
      ticketId,
      messageId,
      emoji: 'a.b',
      on: true,
    });
    expect((await M(b.id, ticketId, messageId)).reactions).toEqual({
      '👍': [cora.uid, asha.uid],
      'a.b': [asha.uid],
    });
    await call(cora, 'messageReact', {
      boardId: b.id,
      ticketId,
      messageId,
      emoji: '👍',
      on: false,
    });
    expect((await M(b.id, ticketId, messageId)).reactions['👍']).toEqual([asha.uid]);
    expect(s.notified).toEqual([]);
    await expect(
      call(asha, 'messageReact', {
        boardId: b.id,
        ticketId,
        messageId: 'nope',
        emoji: '👍',
        on: true,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    // the row is intact on the ticket document
    expect(await msgOf(b.id, ticketId, messageId)).toBeDefined();
  });
});

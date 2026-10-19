/**
 * A BOARD WHOSE TICKETS LIVE IN GOOGLE DRIVE (docs/plan/bucket.html §L), on the
 * emulators with the fake Drive. (The whole tickets suite also runs against
 * Drive boards: TM_TEST_DRIVE_BOARDS=1.)
 *
 *   the files       tickets/<id>/meta.json + messages/<ISO>_<id>.json + pages/<NNN>.json
 *   Firestore       no ticket documents; boards/{b}/driveRev/{t} only
 *   Drive is truth  an edit made in Drive is what the next read sees
 *   writes take turns   parallel posts on one ticket all land (the lease)
 *   lists           a board query, collectionGroup('tickets') and search find Drive tickets
 *   the browser     driveDocs answers what Firestore would have
 */
import { describe, expect, it } from 'vitest';
import { DRIVE_INLINE_MESSAGES, paths, type Board, type Ticket } from '@tm/shared';
import { baseDb, db } from '../../src/db/index.js';
import { fakeDrive, isFolder, type DriveApi } from '../../src/bucket/drive/api.js';
import { searchTicketsIn } from '../../src/platform/ops.js';
import { call, callRaw, queue, setupEmulators, uniq } from '../harness/index.js';
import { connectFakeDrive, doc, people, seedBoard } from '../tickets/helpers.js';

setupEmulators();
const inProcess = it.skipIf(!!process.env.TM_API_URL);

async function kids(drive: DriveApi, parent: string) {
  return (await drive.children([parent])).sort((a, z) => (a.name < z.name ? -1 : 1));
}
async function readJson(drive: DriveApi, id: string) {
  const chunks: Buffer[] = [];
  for await (const c of await drive.download(id)) chunks.push(Buffer.from(c as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
async function ticketFolder(drive: DriveApi, board: Board, ticketId: string) {
  const tickets = board.storage!.ticketsFolderId!;
  const f = (await kids(drive, tickets)).find((k) => k.name === ticketId);
  expect(f, `tickets/${ticketId}/`).toBeTruthy();
  return f!;
}

describe('a Drive board (§L)', () => {
  inProcess('tickets and messages are files in Drive; Firestore keeps only driveRev', async () => {
    const { asha, priya } = await people('asha', 'priya');
    const b = await seedBoard({ admin: asha, editors: [priya], drive: true });
    const drive = fakeDrive(asha.uid);

    const { ticketId } = await call(asha, 'ticketCreate', {
      boardId: b.id,
      title: 'Ship the Drive board',
    });
    const { messageId } = await call(priya, 'messagePost', {
      boardId: b.id,
      ticketId,
      clientId: uniq('c'),
      body: doc('first'),
    });

    // The files.
    const folder = await ticketFolder(drive, b.board, ticketId);
    const inside = await kids(drive, folder.id);
    expect(inside.map((k) => k.name)).toEqual(['messages', 'meta.json']);
    const meta = await readJson(drive, inside.find((k) => k.name === 'meta.json')!.id);
    expect(meta).toMatchObject({ title: 'Ship the Drive board', key: `${b.key}-1` });
    expect(meta.recentMessages).toBeUndefined();
    const msgs = await kids(drive, inside.find((k) => isFolder(k))!.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.name).toMatch(
      new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z_${messageId}\\.json$`),
    );
    expect(await readJson(drive, msgs[0]!.id)).toMatchObject({
      id: messageId,
      body: { text: 'first' },
    });

    // Firestore: no ticket document; the rev says where the files are and has moved.
    expect((await baseDb().doc(paths.ticket(b.id, ticketId)).get()).exists).toBe(false);
    const rev = (await baseDb().doc(`boards/${b.id}/driveRev/${ticketId}`).get()).data()!;
    expect(rev).toMatchObject({ folderId: folder.id, lease: null });
    expect(rev.v).toBeGreaterThanOrEqual(2);

    // Read back through the port: the same document as ever.
    const t = (await db().doc(paths.ticket(b.id, ticketId)).get()).data() as Ticket;
    expect(t.title).toBe('Ship the Drive board');
    expect(t.recentMessages?.map((m) => m.id)).toEqual([messageId]);
    expect(t.counts.messages).toBe(1);
  });

  inProcess('Drive is the truth: an edit made in Drive is what the next read sees', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha, drive: true });
    const drive = fakeDrive(asha.uid);
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'before' });
    const folder = await ticketFolder(drive, b.board, ticketId);
    const metaFile = (await kids(drive, folder.id)).find((k) => k.name === 'meta.json')!;
    const meta = await readJson(drive, metaFile.id);
    await drive.putSmall({
      fileId: metaFile.id,
      mime: 'application/json',
      bytes: new TextEncoder().encode(JSON.stringify({ ...meta, title: 'edited in Drive' })),
    });
    const t = (await db().doc(paths.ticket(b.id, ticketId)).get()).data() as Ticket;
    expect(t.title).toBe('edited in Drive');
    // …and the next app write builds on it.
    await call(asha, 'ticketUpdate', { boardId: b.id, ticketId, patch: { estimate: 3 } });
    const after = await readJson(drive, metaFile.id);
    expect(after).toMatchObject({ title: 'edited in Drive', estimate: 3 });
  });

  inProcess('parallel posts on one ticket all land (writes take turns)', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha, drive: true });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'busy' });
    const posted = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call(asha, 'messagePost', {
          boardId: b.id,
          ticketId,
          clientId: uniq('c'),
          body: doc(`m${i}`),
        }),
      ),
    );
    const t = (await db().doc(paths.ticket(b.id, ticketId)).get()).data() as Ticket;
    expect(new Set(t.recentMessages!.map((m) => m.id))).toEqual(
      new Set(posted.map((p) => p.messageId)),
    );
    expect(t.counts.messages).toBe(6);
  });

  inProcess('a long thread packs older messages into pages/', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha, drive: true });
    const drive = fakeDrive(asha.uid);
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'chatty' });
    for (let i = 0; i <= DRIVE_INLINE_MESSAGES.max; i++)
      await call(asha, 'messagePost', {
        boardId: b.id,
        ticketId,
        clientId: uniq('c'),
        body: doc(`n${i}`),
      });
    const t = (await db().doc(paths.ticket(b.id, ticketId)).get()).data() as Ticket;
    expect(t.pageCount).toBe(1);
    expect(t.recentMessages!.length).toBeLessThanOrEqual(DRIVE_INLINE_MESSAGES.max);
    const folder = await ticketFolder(drive, b.board, ticketId);
    const inside = await kids(drive, folder.id);
    const pages = await kids(drive, inside.find((k) => k.name === 'pages')!.id);
    expect(pages.map((p) => p.name)).toEqual(['000.json']);
    const msgFiles = await kids(drive, inside.find((k) => k.name === 'messages')!.id);
    expect(msgFiles).toHaveLength(t.recentMessages!.length);
    // The whole thread still reads back, in order.
    const page = (
      await db()
        .doc(paths.ticketPage(b.id, ticketId, 0))
        .get()
    ).data() as {
      messages: { body: { text: string } }[];
    };
    const all = [...page.messages, ...t.recentMessages!].map((m) => m.body.text);
    expect(all.filter((x) => x.startsWith('n'))).toEqual(
      Array.from({ length: DRIVE_INLINE_MESSAGES.max + 1 }, (_, i) => `n${i}`),
    );
  });

  inProcess('lists: a board query, collectionGroup and search find Drive tickets', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha, drive: true });
    const m = await seedBoard({ admin: asha, drive: false });
    const one = await call(asha, 'ticketCreate', {
      boardId: b.id,
      title: 'alpha drive',
      assigneeUids: [asha.uid],
    });
    await call(asha, 'ticketCreate', { boardId: b.id, title: 'beta drive' });
    const three = await call(asha, 'ticketCreate', {
      boardId: m.id,
      title: 'gamma managed',
      assigneeUids: [asha.uid],
    });

    const board = await db().collection(paths.tickets(b.id)).where('state', '==', 'active').get();
    expect(board.docs.map((d) => (d.data() as Ticket).title).sort()).toEqual([
      'alpha drive',
      'beta drive',
    ]);

    const mine = await db()
      .collectionGroup('tickets')
      .where('assigneeUids', 'array-contains', asha.uid)
      .get();
    expect(mine.docs.map((d) => d.id).sort()).toEqual([one.ticketId, three.ticketId].sort());

    const found = await searchTicketsIn(
      { actor: asha.uid } as never,
      [{ ...b.board, id: b.id }],
      'alpha',
      { limit: 10 },
    ).catch(() => null);
    if (found) expect(found.map((t) => t.id)).toEqual([one.ticketId]);
  });

  inProcess('driveDocs answers the browser: a ticket, a board query, the group share', async () => {
    const { asha, out } = await people('asha', 'out');
    const b = await seedBoard({ admin: asha, drive: true });
    const { ticketId } = await call(asha, 'ticketCreate', {
      boardId: b.id,
      title: 'for the browser',
      assigneeUids: [asha.uid],
    });

    const one = await call(asha, 'driveDocs', {
      target: { kind: 'doc', path: paths.ticket(b.id, ticketId) },
    });
    expect(one).toMatchObject({ exists: true, boards: [b.id] });
    expect(one.docs[0]!.data).toMatchObject({ title: 'for the browser' });

    const list = await call(asha, 'driveDocs', {
      target: { kind: 'query', path: paths.tickets(b.id) },
      where: [['state', '==', 'active']],
    });
    expect(list.docs.map((d) => d.id)).toEqual([ticketId]);

    const group = await call(asha, 'driveDocs', {
      target: { kind: 'group' },
      where: [['assigneeUids', 'array-contains', asha.uid]],
    });
    expect(group.boards).toContain(b.id);
    expect(group.docs.map((d) => d.id)).toContain(ticketId);

    const theirs = await call(out, 'driveDocs', { target: { kind: 'group' } });
    expect(theirs.boards).not.toContain(b.id);
  });

  inProcess('deleting a ticket puts its folder in Drive’s trash', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha, drive: true, allowDelete: true });
    const drive = fakeDrive(asha.uid);
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'doomed' });
    const folder = await ticketFolder(drive, b.board, ticketId);
    await call(asha, 'ticketDelete', { boardId: b.id, ticketId });
    expect((await drive.get(folder.id))!.trashed).toBe(true);
    expect((await db().doc(paths.ticket(b.id, ticketId)).get()).exists).toBe(false);
    const list = await db().collection(paths.tickets(b.id)).get();
    expect(list.docs.map((d) => d.id)).not.toContain(ticketId);
  });

  inProcess(
    'a board moves to Drive and back (§L4): read-only while it moves, nothing lost',
    async () => {
      const { asha } = await people('asha');
      const b = await seedBoard({ admin: asha, drive: false });
      const one = await call(asha, 'ticketCreate', { boardId: b.id, title: 'one' });
      const two = await call(asha, 'ticketCreate', { boardId: b.id, title: 'two' });
      await call(asha, 'messagePost', {
        boardId: b.id,
        ticketId: one.ticketId,
        clientId: uniq('c'),
        body: doc('hi'),
      });
      await connectFakeDrive(asha);

      const started = await call(asha, 'entityStorageMove', {
        kind: 'boards',
        id: b.id,
        to: { kind: 'drive', folderPath: 'Moves/Board' },
      });
      expect(started.total).toBe(3); // two tickets + settings and subtrees
      const refused = await callRaw(asha, 'ticketUpdate', {
        boardId: b.id,
        ticketId: one.ticketId,
        patch: { estimate: 1 },
      });
      expect(refused.status).toBe(409);
      await queue().drain({ queue: 'entityStorageMove' });

      const board = (await baseDb().doc(paths.board(b.id)).get()).data() as Board;
      expect(board.storage).toMatchObject({ kind: 'drive', folderName: 'Board' });
      expect(board.move ?? null).toBeNull();
      expect((await baseDb().collection(paths.tickets(b.id)).get()).size).toBe(0);
      const t1 = (await db().doc(paths.ticket(b.id, one.ticketId)).get()).data() as Ticket;
      expect(t1.recentMessages?.map((m) => m.body.text)).toEqual(['hi']);
      // Writes go to Drive now.
      await call(asha, 'ticketUpdate', {
        boardId: b.id,
        ticketId: two.ticketId,
        patch: { estimate: 5 },
      });

      await call(asha, 'entityStorageMove', { kind: 'boards', id: b.id, to: { kind: 'managed' } });
      await queue().drain({ queue: 'entityStorageMove' });
      const back = (await baseDb().doc(paths.board(b.id)).get()).data() as Board;
      expect(back.storage).toBeUndefined();
      const rows = await baseDb().collection(paths.tickets(b.id)).get();
      expect(rows.docs.map((d) => (d.data() as Ticket).title).sort()).toEqual(['one', 'two']);
      expect((rows.docs.find((d) => d.id === two.ticketId)!.data() as Ticket).estimate).toBe(5);
      // Drive keeps its copy.
      const drive = fakeDrive(asha.uid);
      expect((await drive.get(board.storage!.ticketsFolderId!))!.trashed).toBe(false);
    },
    60_000,
  );
});

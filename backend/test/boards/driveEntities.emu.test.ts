/**
 * EVERY ENTITY CAN LIVE IN GOOGLE DRIVE (docs/plan/bucket.html §L4–§L7), on the
 * emulators with the fake Drive:
 *
 *   a board      settings.json, views/, archive/; the database keeps the rest
 *   a dictionary its entries sealed (.enc.json) with its data key
 *   an artifact  its data tabs as files; the browser writes them through driveDocWrite
 *   moves        a dictionary database → Drive → database
 *   import       a folder (this instance's or "another's") becomes the entity again;
 *                sealed secrets need the recovery code
 */
import { describe, expect, it } from 'vitest';
import { paths, type Board, type Ticket } from '@tm/shared';
import { baseDb, db } from '../../src/db/index.js';
import { fakeDrive, isFolder, type DriveApi } from '../../src/bucket/drive/api.js';
import { clearDataKeys } from '../../src/db/drive/keyring.js';
import { forgetEntityStorage } from '../../src/db/drive/board.js';
import { clearDocFolderCache } from '../../src/db/drive/docfiles.js';
import { clearDriveTicketCache } from '../../src/db/drive/files.js';
import { call, callRaw, queue, setupEmulators, uniq } from '../harness/index.js';
import { connectFakeDrive, people, seedBoard } from '../tickets/helpers.js';

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
async function child(drive: DriveApi, parent: string, name: string) {
  const f = (await kids(drive, parent)).find((k) => k.name === name);
  expect(f, name).toBeTruthy();
  return f!;
}

describe('a Drive board keeps its settings, views and archive in Drive (§L5)', () => {
  inProcess('settings.json is the truth; the database keeps access and counters', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha, drive: true });
    const drive = fakeDrive(asha.uid);
    const root = b.board.storage!.folderId;

    const settings = await readJson(drive, (await child(drive, root, 'settings.json')).id);
    expect((settings.stages as unknown[]).length).toBe(4);
    const raw = (await baseDb().doc(paths.board(b.id)).get()).data()!;
    expect(raw.stages).toBeUndefined();
    expect(raw.readerUids).toEqual([asha.uid]);

    // Read through the port: one board, as ever.
    const merged = (await db().doc(paths.board(b.id)).get()).data() as Board;
    expect(merged.stages.map((s) => s.name)).toEqual(['To do', 'Doing', 'Review', 'Done']);
    expect(merged.access[asha.uid]).toBe('admin');

    // An app write of a setting lands in the file, not the database.
    await call(asha, 'boardUpdate', {
      boardId: b.id,
      patch: { tags: [{ id: 'tg_new', name: 'new', position: 0 }] },
    });
    const after = await readJson(drive, (await child(drive, root, 'settings.json')).id);
    expect(after.tags).toEqual([expect.objectContaining({ id: 'tg_new', name: 'new' })]);
    expect((await baseDb().doc(paths.board(b.id)).get()).data()!.tags).toBeUndefined();
  });

  inProcess('a view is views/<id>.json; an archived ticket moves to archive/', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha, drive: true });
    const drive = fakeDrive(asha.uid);
    const root = b.board.storage!.folderId;

    await db()
      .doc(paths.view(b.id, 'v_mine'))
      .set({ name: 'Mine', scope: 'shared', kind: 'board' });
    const views = await child(drive, root, 'views');
    expect((await kids(drive, views.id)).map((k) => k.name)).toEqual(['v_mine.json']);
    expect((await baseDb().doc(paths.view(b.id, 'v_mine')).get()).exists).toBe(false);
    const listed = await db().collection(paths.views(b.id)).where('scope', '==', 'shared').get();
    expect(listed.docs.map((d) => d.id)).toEqual(['v_mine']);

    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'old news' });
    await call(asha, 'ticketState', { boardId: b.id, ticketId, state: 'archived' });
    const archive = await child(drive, root, 'archive');
    expect((await kids(drive, archive.id)).map((k) => k.name)).toEqual([ticketId]);
    const tickets = await child(drive, root, 'tickets');
    expect((await kids(drive, tickets.id)).map((k) => k.name)).not.toContain(ticketId);
    const active = await db().collection(paths.tickets(b.id)).where('state', '==', 'active').get();
    expect(active.docs.map((d) => d.id)).not.toContain(ticketId);
    // …and still opens.
    expect(((await db().doc(paths.ticket(b.id, ticketId)).get()).data() as Ticket).title).toBe(
      'old news',
    );

    await call(asha, 'ticketState', { boardId: b.id, ticketId, state: 'active' });
    expect((await kids(drive, tickets.id)).map((k) => k.name)).toContain(ticketId);
  });
});

describe('a Drive dictionary keeps its entries sealed (§L6)', () => {
  inProcess(
    'create in Drive, entries sealed, read back, import elsewhere with the code',
    async () => {
      const { owner } = await people('owner');
      await connectFakeDrive(owner);
      const { dictionaryId } = await call(owner, 'dictionaryCreate', {
        name: `Secrets ${uniq('d')}`,
        storage: { kind: 'drive' },
        entries: [{ key: 'API_KEY', value: 'sk-123' }],
      });
      const d = (await baseDb().doc(paths.dictionary(dictionaryId)).get()).data()!;
      expect(d.storage).toMatchObject({ kind: 'drive' });
      expect((await baseDb().doc(paths.dictionaryContent(dictionaryId)).get()).exists).toBe(false);

      const drive = fakeDrive(owner.uid);
      const root = d.storage.folderId as string;
      const content = await child(drive, root, 'content');
      const file = await child(drive, content.id, 'entries.enc.json');
      const sealed = await readJson(drive, file.id);
      expect(sealed.$tm).toBe('tm/sealed@1');
      expect(JSON.stringify(sealed)).not.toContain('sk-123');
      await child(drive, root, '.tm-keys.json');

      const got = await call(owner, 'dictionaryGet', { dictionaryId });
      expect(got.entries).toEqual([{ key: 'API_KEY', value: 'sk-123' }]);

      // "Another TaskManager": the instance's seal no longer opens, and the dictionary is not here.
      const keysFile = await child(drive, root, '.tm-keys.json');
      const keys = await readJson(drive, keysFile.id);
      await drive.putSmall({
        fileId: keysFile.id,
        mime: 'application/json',
        bytes: new TextEncoder().encode(JSON.stringify({ ...keys, instance: 'v1.x.y.z' })),
      });
      await baseDb().doc(paths.dictionary(dictionaryId)).delete();
      clearDataKeys();
      clearDocFolderCache();
      forgetEntityStorage('dictionaries', dictionaryId);

      const locked = await callRaw(owner, 'driveImport', { folderId: root });
      expect(locked.status).toBe(409);
      const { code } = await call(owner, 'driveRecoveryCode', { take: true });
      expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{1,4})+$/);
      const imported = await call(owner, 'driveImport', { folderId: root, recoveryCode: code! });
      expect(imported).toMatchObject({ kind: 'dictionaries', id: dictionaryId });
      clearDataKeys();
      expect((await call(owner, 'dictionaryGet', { dictionaryId })).entries).toEqual([
        { key: 'API_KEY', value: 'sk-123' },
      ]);
      // The code is shown once.
      expect((await call(owner, 'driveRecoveryCode', { take: true })).code).toBeNull();
    },
  );

  inProcess(
    'a dictionary moves to Drive and back',
    async () => {
      const { owner } = await people('owner');
      await connectFakeDrive(owner);
      const { dictionaryId } = await call(owner, 'dictionaryCreate', {
        name: `Move ${uniq('d')}`,
        entries: [{ key: 'A', value: '1' }],
      });
      await call(owner, 'entityStorageMove', {
        kind: 'dictionaries',
        id: dictionaryId,
        to: { kind: 'drive', folderPath: 'Moves/Dict' },
      });
      await queue().drain({ queue: 'entityStorageMove' });
      const d = (await baseDb().doc(paths.dictionary(dictionaryId)).get()).data()!;
      expect(d.storage).toMatchObject({ kind: 'drive', folderName: 'Dict' });
      expect((await baseDb().doc(paths.dictionaryContent(dictionaryId)).get()).exists).toBe(false);
      expect((await call(owner, 'dictionaryGet', { dictionaryId })).entries).toEqual([
        { key: 'A', value: '1' },
      ]);

      await call(owner, 'entityStorageMove', {
        kind: 'dictionaries',
        id: dictionaryId,
        to: { kind: 'managed' },
      });
      await queue().drain({ queue: 'entityStorageMove' });
      const back = (await baseDb().doc(paths.dictionary(dictionaryId)).get()).data()!;
      expect(back.storage).toBeUndefined();
      expect((await baseDb().doc(paths.dictionaryContent(dictionaryId)).get()).exists).toBe(true);
      expect((await call(owner, 'dictionaryGet', { dictionaryId })).entries).toEqual([
        { key: 'A', value: '1' },
      ]);
    },
    60_000,
  );
});

describe('a Drive artifact keeps its data as files (§L5)', () => {
  inProcess(
    'the broker writes through driveDocWrite; driveDocs reads; files in db/data/',
    async () => {
      const { owner, stranger } = await people('owner', 'stranger');
      await connectFakeDrive(owner);
      const made = await call(owner, 'artifactCreate', {
        name: `Dash ${uniq('a')}`,
        storage: { kind: 'drive' },
      });
      const { artifactId } = made;
      // Its buckets are entities of their own: no files/ folder made for one.
      expect(made).not.toHaveProperty('filesFolderId');
      const path = `artifacts/${artifactId}/db/data/orders/o1`;
      await call(owner, 'driveDocWrite', {
        path,
        method: 'set',
        data: { total: 12, at: { __sv: 'now' }, when: { __ts: 1_750_000_000_000 } },
      });
      const one = await call(owner, 'driveDocs', { target: { kind: 'doc', path } });
      expect(one.docs[0]!.data).toMatchObject({ total: 12, when: { __ts: 1_750_000_000_000 } });
      expect(one.entity).toMatchObject({ kind: 'artifacts', id: artifactId });
      const list = await call(owner, 'driveDocs', {
        target: { kind: 'query', path: `artifacts/${artifactId}/db/data/orders` },
        where: [['total', '>', 10]],
      });
      expect(list.docs.map((d) => d.id)).toEqual(['o1']);
      expect((await baseDb().doc(path).get()).exists).toBe(false);

      const a = (await baseDb().doc(`artifacts/${artifactId}`).get()).data()!;
      const drive = fakeDrive(owner.uid);
      const dbFolder = await child(drive, a.storage.folderId, 'db');
      const data = await child(drive, dbFolder.id, 'data');
      const orders = await child(drive, data.id, 'orders');
      expect((await kids(drive, orders.id)).map((k) => k.name)).toEqual(['o1.json']);
      expect(isFolder(orders)).toBe(true);

      const refused = await callRaw(stranger, 'driveDocs', { target: { kind: 'doc', path } });
      expect(refused.status).toBe(404);
    },
  );
});

describe('import from Drive (§L7)', () => {
  inProcess('a board comes back from its folder: tickets, keys, settings, numbering', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha, drive: true });
    const t1 = await call(asha, 'ticketCreate', { boardId: b.id, title: 'first' });
    await call(asha, 'ticketCreate', { boardId: b.id, title: 'second' });
    // A fresh instance: nothing of the board in the database.
    const base = baseDb();
    await base.recursiveDelete(base.doc(paths.board(b.id)));
    for (const k of [`${b.key}-1`, `${b.key}-2`]) await base.doc(paths.key(k)).delete();
    await base
      .doc(paths.boardKey(b.key))
      .delete()
      .catch(() => undefined);
    forgetEntityStorage('boards', b.id);
    clearDriveTicketCache();
    clearDocFolderCache();

    // (The emulator's users/ rows carry no name; the import's member row takes it from there.)
    await base
      .doc(`users/${asha.uid}`)
      .set({ name: 'asha', email: asha.email, avatarPath: null }, { merge: true });
    // The manifest was written by the router after the board's writes.
    const imported = await call(asha, 'driveImport', { folderId: b.board.storage!.folderId });
    expect(imported).toMatchObject({ kind: 'boards', id: b.id, key: b.key });
    const board = (await db().doc(paths.board(b.id)).get()).data() as Board;
    expect(board.nextNumber).toBe(3);
    expect(board.stages.length).toBe(4);
    expect(((await db().doc(paths.ticket(b.id, t1.ticketId)).get()).data() as Ticket).title).toBe(
      'first',
    );
    expect((await base.doc(paths.key(`${b.key}-1`)).get()).data()).toMatchObject({
      ticketId: t1.ticketId,
      boardId: b.id,
    });
    const third = await call(asha, 'ticketCreate', { boardId: b.id, title: 'third' });
    expect(third.key).toBe(`${b.key}-3`);
  });
});

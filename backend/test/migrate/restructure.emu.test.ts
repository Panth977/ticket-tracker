/**
 * The restructure migration (backend/src/migrate/restructure.ts) on data in
 * its OLD shape: memories/ and their nodes and objects, memory keys in
 * tickets, boards, tokens and sidebars, workspaces — and no owners, handles
 * or orgs. After it: buckets/, the new keys, owners, handles, an org per
 * workspace with its owner's things in it. A second run plans nothing.
 */
import { describe, expect, it } from 'vitest';
import { storageBucket } from '../../src/blob/index.js';
import { db } from '../../src/runtime/firebase.js';
import { migrateRestructure } from '../../src/migrate/restructure.js';
import { setupEmulators, uniq } from '../harness/index.js';
import { people, seedBoard } from '../tickets/helpers.js';

setupEmulators();

describe('restructure migration', () => {
  it('memory → bucket, owners and handles, workspaces → orgs; idempotent', async () => {
    const { asha, ben } = await people('asha', 'ben');
    const board = await seedBoard({ admin: asha, editors: [ben] });
    const m = uniq('m');
    const n = uniq('n');
    const obj = `memories/${m}/f1/notes.md`;

    // ── the old shape ──
    await db()
      .doc(`memories/${m}`)
      .set({
        name: 'Old notes',
        description: 'My memory of things',
        icon: null,
        ownerUid: asha.uid,
        access: { [asha.uid]: 'owner' },
        memberUids: [asha.uid],
        boards: { [board.id]: 'write' },
        artifacts: {},
        boardIds: [board.id],
        stats: { files: 1, folders: 0, bytes: 5 },
        archivedAt: null,
        createdAt: 1,
        updatedAt: 1,
      });
    await db()
      .doc(`memories/${m}/nodes/${n}`)
      .set({ kind: 'file', name: 'notes.md', path: 'notes.md', storagePath: obj });
    await storageBucket().file(obj).save(Buffer.from('hello'), { contentType: 'text/markdown' });
    await db()
      .doc(`boards/${board.id}`)
      .update({ attachMemory: { memoryId: m, template: '<filename>' } });
    const tk = uniq('t');
    await db()
      .doc(`boards/${board.id}/tickets/${tk}`)
      .set({
        title: 'remember the memory',
        files: [
          {
            id: 'f',
            name: 'notes.md',
            source: 'memory',
            path: `memories/${m}/nodes/${n}`,
            memory: { memoryId: m, nodeId: n },
          },
        ],
      });
    await db()
      .doc(`users/${asha.uid}/ui/sidebar`)
      .set({ hiddenBoardIds: [], hiddenArtifactIds: [], hiddenMemoryIds: [m], updatedAt: 1 });
    await db()
      .doc(`users/${asha.uid}/workspaces/${uniq('w')}`)
      .set({
        name: 'Client Work',
        color: '#6366F1',
        boardIds: [board.id],
        artifactIds: [],
        memoryIds: [m],
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      });

    const s = await migrateRestructure({ db: db(), bucket: storageBucket(), apply: true });
    expect(s).toMatchObject({ bucketsMoved: 1, nodesMoved: 1, orgs: 1 });

    // ── 1: memory → bucket ──
    expect((await db().doc(`memories/${m}`).get()).exists).toBe(false);
    const b = (await db().doc(`buckets/${m}`).get()).data()!;
    expect(b).toMatchObject({ name: 'Old notes', description: 'My memory of things' }); // people's words untouched
    const node = (await db().doc(`buckets/${m}/nodes/${n}`).get()).data()!;
    expect(node.storagePath).toBe(`buckets/${m}/f1/notes.md`);
    const [moved] = await storageBucket().file(`buckets/${m}/f1/notes.md`).download();
    expect(moved.toString()).toBe('hello');
    expect((await storageBucket().file(obj).exists())[0]).toBe(false);
    const t = (await db().doc(`boards/${board.id}/tickets/${tk}`).get()).data()!;
    expect(t.title).toBe('remember the memory');
    expect(t.files[0]).toMatchObject({
      source: 'bucket',
      path: `buckets/${m}/nodes/${n}`,
      bucket: { bucketId: m, nodeId: n },
    });
    const side = (await db().doc(`users/${asha.uid}/ui/sidebar`).get()).data()!;
    expect(side.hiddenBucketIds).toEqual([m]);

    // ── 2 + 3: handles, owners, an org from the workspace holding her board and bucket ──
    const user = (await db().doc(`users/${asha.uid}`).get()).data()!;
    expect(user.handle).toMatch(/^[a-z0-9-]+$/);
    const brd = (await db().doc(`boards/${board.id}`).get()).data()!;
    expect(brd.attachBucket).toEqual({ bucketId: m, template: '<filename>' });
    expect(brd.owner.kind).toBe('org');
    const org = (await db().doc(`orgs/${brd.owner.id}`).get()).data()!;
    expect(org).toMatchObject({ name: 'Client Work', members: { [asha.uid]: 'owner' } });
    expect(brd.ownerHandle).toBe(org.handle);
    expect((await db().doc(`handles/${org.handle}`).get()).data()).toEqual({
      kind: 'org',
      id: brd.owner.id,
    });
    expect((await db().doc(`buckets/${m}`).get()).data()).toMatchObject({
      ownerKey: `org:${brd.owner.id}`,
      slug: 'old-notes',
    });
    expect((await db().collection(`users/${asha.uid}/workspaces`).get()).size).toBe(0);

    // ── idempotent ──
    const again = await migrateRestructure({ db: db(), bucket: storageBucket(), apply: false });
    expect(again).toMatchObject({
      bucketsMoved: 0,
      objectsMoved: 0,
      orgs: 0,
      owners: 0,
      movedIntoOrgs: 0,
      workspacesRemoved: 0,
    });
  });
});

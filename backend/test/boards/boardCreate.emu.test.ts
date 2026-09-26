import { describe, expect, it } from 'vitest';
import { paths, rateBuckets, rtdb } from '@tm/shared';
import { db, rtdbAdmin } from '../../src/runtime/firebase.js';
import { setupEmulators } from '../harness/index.js';
import {
  addMember,
  call,
  createUser,
  getBoard,
  getMember,
  getViews,
  newBoard,
  readers,
  uniqKey,
} from './helpers.js';

setupEmulators();

describe('boardCreate', () => {
  it('creates board, key claim, admin member row, prefs, default views and the RTDB mirror', async () => {
    const alice = await createUser({ name: 'Alice' });
    const key = uniqKey();
    const { boardId } = await call(alice, 'boardCreate', { name: 'Engineering', key });

    const b = (await getBoard(boardId))!;
    expect(b).toMatchObject({
      name: 'Engineering',
      key,
      nextNumber: 1,
      access: { [alice.uid]: 'admin' },
      readerUids: [alice.uid],
      editorUids: [alice.uid],
      archivedAt: null,
      createdBy: alice.uid,
    });
    expect(b.stages.map((s) => s.category)).toEqual(['todo', 'active', 'done']);
    expect(b.priorities).toHaveLength(4);

    const claim = (await db().doc(paths.boardKey(key)).get()).data();
    expect(claim).toMatchObject({ boardId });

    expect(await getMember(boardId, alice.uid)).toMatchObject({
      uid: alice.uid,
      role: 'admin',
      name: 'Alice',
      email: alice.email,
      invitedBy: null,
    });

    const views = await getViews(boardId);
    expect(views.map((v) => v.name).sort()).toEqual(['Board', 'Calendar', 'Mine', 'Table']);
    const def = views.find((v) => v.id === b.defaultViewId)!;
    expect(def).toMatchObject({ name: 'Board', type: 'kanban', groupBy: 'stage', scope: 'shared' });
    expect(views.find((v) => v.name === 'Mine')!.filter).toEqual({
      field: 'assignee',
      cmp: 'is',
      value: 'me',
    });

    const pref = (await db().doc(paths.pref(boardId, alice.uid)).get()).data();
    expect(pref).toMatchObject({ lastViewId: b.defaultViewId, starred: false });
    expect(await readers(boardId)).toEqual({ [alice.uid]: true });
  });

  it('409 when the key is taken', async () => {
    const alice = await createUser();
    const { key } = await newBoard(alice);
    await expect(call(alice, 'boardCreate', { name: 'Again', key })).rejects.toMatchObject({
      code: 'conflict',
      details: { key },
    });
  });

  it('templates: bug tracker has triage/cancelled stages, severity field and bug tags', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice, { template: 'bugs' });
    const b = (await getBoard(boardId))!;
    expect(b.stages.map((s) => s.name)).toContain('Triage');
    expect(b.stages.some((s) => s.category === 'cancelled')).toBe(true);
    expect(b.fields.map((f) => f.name)).toContain('Severity');
    expect(b.fields.every((f) => /^f_[a-z0-9]{6}$/.test(f.id))).toBe(true);
    expect(b.tags.map((t) => t.name)).toContain('bug');
    const k = await newBoard(alice, { template: 'kanban' });
    expect((await getBoard(k.boardId))!.stages).toHaveLength(5);
  });

  it('copy a board: stages, fields, shared views — never people or personal views', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const src = await newBoard(alice, { template: 'support' });
    await addMember(src.boardId, bob, 'editor');
    await call(alice, 'viewSave', {
      boardId: src.boardId,
      view: {
        name: 'My secret',
        type: 'table',
        scope: 'personal',
        position: 9,
        filter: null,
        sort: [],
        groupBy: null,
        subGroupBy: null,
        columns: [],
        dateField: null,
        endDateField: null,
        cardFields: [],
        includeStates: ['active'],
      },
    });
    const s = (await getBoard(src.boardId))!;

    const { boardId } = await call(bob, 'boardCreate', {
      name: 'Copy',
      key: uniqKey(),
      template: { fromBoardId: src.boardId },
    });
    const b = (await getBoard(boardId))!;
    expect(b.stages).toEqual(s.stages);
    expect(b.fields).toEqual(s.fields);
    expect(b.access).toEqual({ [bob.uid]: 'admin' });
    const views = await getViews(boardId);
    expect(views.map((v) => v.name).sort()).toEqual(['Board', 'Calendar', 'Mine', 'Table']);
    expect(views.every((v) => v.ownerUid === bob.uid)).toBe(true);
    expect(views.find((v) => v.id === b.defaultViewId)!.name).toBe('Board');
  });

  it('copy needs can(read) on the source → 404 for strangers', async () => {
    const alice = await createUser();
    const eve = await createUser();
    const src = await newBoard(alice);
    await expect(
      call(eve, 'boardCreate', {
        name: 'X',
        key: uniqKey(),
        template: { fromBoardId: src.boardId },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rate limit: 10 boards per person per day → 429', async () => {
    const u = await createUser();
    const day = Math.floor(Date.now() / 86_400_000);
    await rtdbAdmin()
      .ref(rtdb.rate(rateBuckets.boardCreates(u.uid), day))
      .set(10);
    await expect(call(u, 'boardCreate', { name: 'X', key: uniqKey() })).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('a 409 does not burn the allowance', async () => {
    const u = await createUser();
    const { key } = await newBoard(u);
    await expect(call(u, 'boardCreate', { name: 'X', key })).rejects.toMatchObject({
      code: 'conflict',
    });
    const day = Math.floor(Date.now() / 86_400_000);
    const n = (
      await rtdbAdmin()
        .ref(rtdb.rate(rateBuckets.boardCreates(u.uid), day))
        .get()
    ).val();
    expect(n).toBe(1);
  });

  it('400 on a bad key', async () => {
    const u = await createUser();
    await expect(call(u, 'boardCreate', { name: 'X', key: 'eng' })).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

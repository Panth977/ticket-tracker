import { describe, expect, it } from 'vitest';
import { paths, type Ticket } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { devOutbox, queue, setupEmulators } from '../harness/index.js';
import {
  addMember,
  call,
  createUser,
  getBoard,
  getMember,
  newBoard,
  readers,
  seedTicket,
} from './helpers.js';
import { actsOf } from '../tickets/store.js';

setupEmulators();

describe('boardAccessSet', () => {
  it('changes roles and keeps access / readerUids / editorUids / members in step', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { boardId } = await newBoard(alice);
    await addMember(boardId, bob, 'viewer');
    await call(alice, 'boardAccessSet', { boardId, people: { [bob.uid]: 'editor' } });
    const b = (await getBoard(boardId))!;
    expect(b.access[bob.uid]).toBe('editor');
    expect(b.editorUids).toContain(bob.uid);
    expect((await getMember(boardId, bob.uid))!.role).toBe('editor');
  });

  it('non-admins 403; strangers 404; never adds new people', async () => {
    const alice = await createUser();
    const ed = await createUser();
    const eve = await createUser();
    const { boardId } = await newBoard(alice);
    await addMember(boardId, ed, 'editor');
    await expect(
      call(ed, 'boardAccessSet', { boardId, people: { [alice.uid]: 'viewer' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(call(eve, 'boardAccessSet', { boardId, leave: true })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      call(alice, 'boardAccessSet', { boardId, people: { [eve.uid]: 'editor' } }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('the last admin cannot be demoted, removed, or leave → 409', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { boardId } = await newBoard(alice);
    await addMember(boardId, bob, 'editor');
    await expect(
      call(alice, 'boardAccessSet', { boardId, people: { [alice.uid]: 'editor' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(call(alice, 'boardAccessSet', { boardId, leave: true })).rejects.toMatchObject({
      code: 'conflict',
    });
    // With a second admin it works.
    await call(alice, 'boardAccessSet', { boardId, people: { [bob.uid]: 'admin' } });
    await call(alice, 'boardAccessSet', { boardId, leave: true });
    const b = (await getBoard(boardId))!;
    expect(b.access).toEqual({ [bob.uid]: 'admin' });
    expect(await getMember(boardId, alice.uid)).toBeUndefined();
    expect(await readers(boardId)).toEqual({ [bob.uid]: true });
  });

  it('removal takes the person off active tickets (with activity), keeps archived ones, and tells them', async () => {
    const alice = await createUser();
    const bob = await createUser({ name: 'Bob' });
    const { boardId } = await newBoard(alice);
    await addMember(boardId, bob, 'editor');
    const stageId = (await getBoard(boardId))!.stages[0]!.id;
    const active = await seedTicket(boardId, {
      stageId,
      assigneeUids: [bob.uid, alice.uid],
      watcherUids: [bob.uid],
    });
    const archived = await seedTicket(boardId, {
      stageId,
      state: 'archived',
      assigneeUids: [bob.uid],
    });

    await call(alice, 'boardAccessSet', { boardId, people: { [bob.uid]: null } });

    const t = (await db().doc(paths.ticket(boardId, active)).get()).data() as Ticket;
    expect(t.assigneeUids).toEqual([alice.uid]);
    expect(t.watcherUids).toEqual([]);
    const act = await actsOf(boardId, active);
    expect(act[0]).toMatchObject({
      action: 'update',
      actor: alice.uid,
      changes: { assigneeUids: { from: [bob.uid, alice.uid], to: [alice.uid] } },
    });
    const a = (await db().doc(paths.ticket(boardId, archived)).get()).data() as Ticket;
    expect(a.assigneeUids).toEqual([bob.uid]);

    const b = (await getBoard(boardId))!;
    expect(b.readerUids).not.toContain(bob.uid);
    expect(await getMember(boardId, bob.uid)).toBeUndefined();
    const mail = await devOutbox('mail', { field: 'to', equals: bob.email });
    expect(mail[0]).toMatchObject({ tag: 'boardRemoved' });
    // And they can no longer read it.
    await expect(
      call(bob, 'boardPrefSet', { boardId, pref: { starred: true } }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('stage grants: commenters only, known stages only; a role change drops the grant', async () => {
    const alice = await createUser();
    const c = await createUser();
    const v = await createUser();
    const { boardId } = await newBoard(alice);
    await addMember(boardId, c, 'commenter');
    await addMember(boardId, v, 'viewer');
    const stages = (await getBoard(boardId))!.stages.map((s) => s.id);

    await call(alice, 'boardAccessSet', {
      boardId,
      stageGrants: { [c.uid]: { stages: stages.slice(0, 2), assignedOnly: true } },
    });
    expect((await getBoard(boardId))!.stageGrants[c.uid]).toEqual({
      stages: stages.slice(0, 2),
      assignedOnly: true,
    });
    expect((await getMember(boardId, c.uid))!.stageGrant).toMatchObject({ assignedOnly: true });

    await expect(
      call(alice, 'boardAccessSet', { boardId, stageGrants: { [v.uid]: { stages } } }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      call(alice, 'boardAccessSet', { boardId, stageGrants: { [c.uid]: { stages: ['nope'] } } }),
    ).rejects.toMatchObject({ code: 'invalid' });

    await call(alice, 'boardAccessSet', { boardId, people: { [c.uid]: 'editor' } });
    expect((await getBoard(boardId))!.stageGrants[c.uid]).toBeUndefined();
    expect((await getMember(boardId, c.uid))!.stageGrant).toBeNull();
  });

  it('anyone may leave', async () => {
    const alice = await createUser();
    const v = await createUser();
    const { boardId } = await newBoard(alice);
    await addMember(boardId, v, 'viewer');
    await call(v, 'boardAccessSet', { boardId, leave: true });
    expect((await getBoard(boardId))!.access[v.uid]).toBeUndefined();
  });
});

describe('boardArchive', () => {
  it('archive / restore by admins only', async () => {
    const alice = await createUser();
    const ed = await createUser();
    const { boardId } = await newBoard(alice);
    await addMember(boardId, ed, 'editor');
    await expect(call(ed, 'boardArchive', { boardId, action: 'archive' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await call(alice, 'boardArchive', { boardId, action: 'archive' });
    expect((await getBoard(boardId))!.archivedAt).toEqual(expect.any(Number));
    await expect(call(alice, 'tagCreate', { boardId, name: 'x' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await call(alice, 'boardArchive', { boardId, action: 'restore' });
    expect((await getBoard(boardId))!.archivedAt).toBeNull();
  });

  it('delete: confirmKey must match; the key stays claimed; tickets, keys and storage go via the queue', async () => {
    const alice = await createUser();
    const { boardId, key } = await newBoard(alice);
    const stageId = (await getBoard(boardId))!.stages[0]!.id;
    const t = await seedTicket(boardId, { stageId });
    const tk = ((await db().doc(paths.ticket(boardId, t)).get()).data() as Ticket).key;
    await db().doc(paths.key(tk)).set({ ticketId: t, boardId, current: tk });

    await expect(
      call(alice, 'boardArchive', { boardId, action: 'delete', confirmKey: 'WRONG' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(call(alice, 'boardArchive', { boardId, action: 'delete' })).rejects.toMatchObject({
      code: 'invalid',
    });

    await call(alice, 'boardArchive', { boardId, action: 'delete', confirmKey: key });
    expect(await getBoard(boardId)).toBeUndefined();
    expect((await db().doc(paths.boardKey(key)).get()).data()).toMatchObject({
      boardId,
      deleted: true,
    });
    expect(await readers(boardId)).toBeNull();
    expect(
      queue()
        .pending()
        .map((p) => p.queue),
    ).toContain('boardDelete');

    await queue().drain({ queue: 'boardDelete' });
    expect((await db().doc(paths.ticket(boardId, t)).get()).exists).toBe(false);
    expect((await db().collection(paths.members(boardId)).get()).size).toBe(0);
    expect((await db().doc(paths.key(tk)).get()).data()).toMatchObject({ deleted: true, boardId });

    // The key is never reissued.
    await expect(call(alice, 'boardCreate', { name: 'Again', key })).rejects.toMatchObject({
      code: 'conflict',
    });
    // And the board is gone for everyone.
    await expect(call(alice, 'boardArchive', { boardId, action: 'restore' })).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    );
  });
});

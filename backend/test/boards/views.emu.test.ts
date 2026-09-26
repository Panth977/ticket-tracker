import { describe, expect, it } from 'vitest';
import { paths, type BoardPref, type ViewInput } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { setupEmulators } from '../harness/index.js';
import { addMember, call, createUser, getBoard, getViews, newBoard } from './helpers.js';

setupEmulators();

const view = (over: Partial<ViewInput> = {}): ViewInput => ({
  name: 'My view',
  type: 'table',
  scope: 'personal',
  position: 5,
  filter: null,
  sort: [],
  groupBy: null,
  subGroupBy: null,
  columns: [],
  dateField: null,
  endDateField: null,
  cardFields: [],
  includeStates: ['active'],
  ...over,
});

const pref = async (boardId: string, uid: string) =>
  (await db().doc(paths.pref(boardId, uid)).get()).data() as BoardPref | undefined;

describe('boardPrefSet', () => {
  it("writes only the caller's own prefs, merged over defaults", async () => {
    const alice = await createUser();
    const v = await createUser();
    const { boardId } = await newBoard(alice);
    await addMember(boardId, v, 'viewer');
    await call(v, 'boardPrefSet', { boardId, pref: { starred: true, mode: 'muted' } });
    await call(v, 'boardPrefSet', { boardId, pref: { events: ['mentioned'] } });
    const b = (await getBoard(boardId))!;
    expect(await pref(boardId, v.uid)).toEqual({
      mode: 'muted',
      starred: true,
      watching: [],
      events: ['mentioned'],
      lastViewId: b.defaultViewId,
    });
    // Alice's own prefs untouched.
    expect((await pref(boardId, alice.uid))!.starred).toBe(false);
  });

  it('no uid parameter; strangers 404; unknown stages / views rejected', async () => {
    const alice = await createUser();
    const eve = await createUser();
    const { boardId } = await newBoard(alice);
    await expect(
      call(alice, 'boardPrefSet', { boardId, pref: { starred: true }, uid: eve.uid } as never),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      call(eve, 'boardPrefSet', { boardId, pref: { starred: true } }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      call(alice, 'boardPrefSet', { boardId, pref: { stageIds: ['nope'] } }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      call(alice, 'boardPrefSet', { boardId, pref: { lastViewId: 'nope' } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('tagCreate', () => {
  it('editors create; same name any case returns the existing tag', async () => {
    const alice = await createUser();
    const ed = await createUser();
    const c = await createUser();
    const { boardId } = await newBoard(alice);
    await addMember(boardId, ed, 'editor');
    await addMember(boardId, c, 'commenter');
    const { tag } = await call(ed, 'tagCreate', { boardId, name: 'Backend', color: 'blue' });
    expect(tag).toMatchObject({ name: 'Backend', color: 'blue', position: 0 });
    const again = await call(alice, 'tagCreate', { boardId, name: 'backend' });
    expect(again.tag).toEqual(tag);
    const second = await call(alice, 'tagCreate', { boardId, name: 'Frontend' });
    expect(second.tag.position).toBe(1);
    expect((await getBoard(boardId))!.tags.map((t) => t.name)).toEqual(['Backend', 'Frontend']);
    await expect(call(c, 'tagCreate', { boardId, name: 'Nope' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('viewSave / viewDelete', () => {
  it('personal views: any reader; owned by the actor; invisible to others', async () => {
    const alice = await createUser();
    const v = await createUser();
    const { boardId } = await newBoard(alice);
    await addMember(boardId, v, 'viewer');
    const { viewId } = await call(v, 'viewSave', { boardId, view: view() });
    const saved = (await getViews(boardId)).find((x) => x.id === viewId)!;
    expect(saved).toMatchObject({ ownerUid: v.uid, scope: 'personal', name: 'My view' });

    // Someone else's personal view: 404 for update and delete.
    await expect(
      call(alice, 'viewSave', { boardId, viewId, view: view({ name: 'Hijack' }) }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(call(alice, 'viewDelete', { boardId, viewId })).rejects.toMatchObject({
      code: 'not_found',
    });
    await call(v, 'viewSave', { boardId, viewId, view: view({ name: 'Renamed' }) });
    await call(v, 'viewDelete', { boardId, viewId });
    expect((await getViews(boardId)).some((x) => x.id === viewId)).toBe(false);
  });

  it('shared views need can(edit); promoting a personal view too', async () => {
    const alice = await createUser();
    const v = await createUser();
    const ed = await createUser();
    const { boardId } = await newBoard(alice);
    await addMember(boardId, v, 'viewer');
    await addMember(boardId, ed, 'editor');
    await expect(
      call(v, 'viewSave', { boardId, view: view({ scope: 'shared' }) }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const mine = await call(v, 'viewSave', { boardId, view: view() });
    await expect(
      call(v, 'viewSave', { boardId, viewId: mine.viewId, view: view({ scope: 'shared' }) }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const { viewId } = await call(ed, 'viewSave', { boardId, view: view({ scope: 'shared' }) });
    // Another editor may edit a shared view; the author stays.
    await call(alice, 'viewSave', {
      boardId,
      viewId,
      view: view({ scope: 'shared', name: 'Team' }),
    });
    const s = (await getViews(boardId)).find((x) => x.id === viewId)!;
    expect(s).toMatchObject({ name: 'Team', ownerUid: ed.uid });
    await expect(call(v, 'viewDelete', { boardId, viewId })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('every field a view names must exist on the board', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice, { template: 'bugs' });
    const f = (await getBoard(boardId))!.fields[0]!;
    await call(alice, 'viewSave', {
      boardId,
      view: view({
        filter: { op: 'and', children: [{ field: `fields.${f.id}`, cmp: 'notEmpty' }] },
      }),
    });
    await expect(
      call(alice, 'viewSave', {
        boardId,
        view: view({ filter: { field: 'fields.f_zzzzzz', cmp: 'notEmpty' } }),
      }),
    ).rejects.toMatchObject({ code: 'invalid', details: { fields: ['fields.f_zzzzzz'] } });
    await expect(
      call(alice, 'viewSave', { boardId, view: view({ groupBy: 'fields.f_yyyyyy' }) }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it("the default view can't be deleted; prefs pointing at a deleted view fall back", async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const b = (await getBoard(boardId))!;
    await expect(
      call(alice, 'viewDelete', { boardId, viewId: b.defaultViewId }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const table = (await getViews(boardId)).find((x) => x.name === 'Table')!;
    await call(alice, 'boardPrefSet', { boardId, pref: { lastViewId: table.id } });
    await call(alice, 'viewDelete', { boardId, viewId: table.id });
    expect((await pref(boardId, alice.uid))!.lastViewId).toBe(b.defaultViewId);
  });

  it('strangers get 404', async () => {
    const alice = await createUser();
    const eve = await createUser();
    const { boardId } = await newBoard(alice);
    await expect(call(eve, 'viewSave', { boardId, view: view() })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

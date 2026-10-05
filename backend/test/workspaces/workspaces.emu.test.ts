/**
 * §AB workspaces + sidebar hiding, and artifacts.html §K board access — the
 * commands behind them. Workspaces are private and grant nothing; the board
 * grant is a ceiling the owner may only set within their own role.
 */
import { describe, expect, it } from 'vitest';
import { paths } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { call, setupEmulators } from '../harness/index.js';
import { people, seedBoard } from '../tickets/helpers.js';

setupEmulators();

const wsDoc = (uid: string, id: string) => db().doc(paths.workspace(uid, id)).get();

describe('workspaces (§AB)', () => {
  it('create, attach / detach, reorder, delete — only things you can open', async () => {
    const { asha, priya } = await people('asha', 'priya');
    const mine = await seedBoard({ admin: asha });
    const theirs = await seedBoard({ admin: priya });
    const { artifactId } = await call(asha, 'artifactCreate', { name: 'Dash' });

    const { workspaceId } = await call(asha, 'workspaceCreate', {
      name: 'Freelance',
      boardIds: [mine.id, mine.id],
    });
    let ws = (await wsDoc(asha.uid, workspaceId)).data()!;
    expect(ws).toMatchObject({
      name: 'Freelance',
      boardIds: [mine.id],
      artifactIds: [],
      position: 0,
    });
    expect(ws.color).toMatch(/^#[0-9A-Fa-f]{6}$/);

    // A board you are not on is refused, by name.
    await expect(
      call(asha, 'workspaceUpdate', { workspaceId, add: { boardIds: [theirs.id] } }),
    ).rejects.toMatchObject({ code: 'invalid', details: { boardIds: [theirs.id] } });

    await call(asha, 'workspaceUpdate', {
      workspaceId,
      name: 'Clients',
      add: { artifactIds: [artifactId] },
    });
    ws = (await wsDoc(asha.uid, workspaceId)).data()!;
    expect(ws).toMatchObject({ name: 'Clients', boardIds: [mine.id], artifactIds: [artifactId] });

    await call(asha, 'workspaceUpdate', { workspaceId, remove: { boardIds: [mine.id] } });
    expect((await wsDoc(asha.uid, workspaceId)).data()!.boardIds).toEqual([]);

    // A second one goes after the first.
    const second = await call(asha, 'workspaceCreate', { name: 'Health' });
    expect((await wsDoc(asha.uid, second.workspaceId)).data()!.position).toBe(1);

    // Nobody else can touch yours: their workspaceId resolves under THEIR user doc.
    await expect(call(priya, 'workspaceDelete', { workspaceId })).rejects.toMatchObject({
      code: 'not_found',
    });
    await call(asha, 'workspaceDelete', { workspaceId });
    expect((await wsDoc(asha.uid, workspaceId)).exists).toBe(false);
    // The board and artifact are untouched.
    expect((await db().doc(paths.board(mine.id)).get()).exists).toBe(true);
  });

  it('sidebarHide: hide and show again; never something you cannot open', async () => {
    const { asha, priya } = await people('asha', 'priya');
    const b = await seedBoard({ admin: asha });
    const other = await seedBoard({ admin: priya });
    await call(asha, 'sidebarHide', { boardId: b.id, hidden: true });
    const side = () => db().doc(paths.sidebarPrefs(asha.uid)).get();
    expect((await side()).data()).toMatchObject({ hiddenBoardIds: [b.id], hiddenArtifactIds: [] });
    // Hiding is UI only: the board is not archived.
    expect((await db().doc(paths.board(b.id)).get()).data()!.archivedAt).toBeNull();
    await call(asha, 'sidebarHide', { boardId: b.id, hidden: false });
    expect((await side()).data()!.hiddenBoardIds).toEqual([]);
    await expect(
      call(asha, 'sidebarHide', { boardId: other.id, hidden: true }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(call(asha, 'sidebarHide', { hidden: true } as never)).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

describe('artifact board access (§K)', () => {
  it('owner grants read / write within their own role; removing is always allowed', async () => {
    const { asha, priya, ravi } = await people('asha', 'priya', 'ravi');
    const own = await seedBoard({ admin: asha });
    const viewOnly = await seedBoard({ admin: priya, viewers: [asha] });
    const notOn = await seedBoard({ admin: ravi });
    const { artifactId } = await call(asha, 'artifactCreate', { name: 'Dash' });
    const boards = async () =>
      (await db().doc(`artifacts/${artifactId}`).get()).data()!.boards as Record<string, string>;

    await call(asha, 'artifactBoardAccessSet', { artifactId, boardId: own.id, access: 'write' });
    await call(asha, 'artifactBoardAccessSet', {
      artifactId,
      boardId: viewOnly.id,
      access: 'read',
    });
    expect(await boards()).toEqual({ [own.id]: 'write', [viewOnly.id]: 'read' });

    // Write needs the owner to be editor+ there; a board they are not on is invisible.
    await expect(
      call(asha, 'artifactBoardAccessSet', { artifactId, boardId: viewOnly.id, access: 'write' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(asha, 'artifactBoardAccessSet', { artifactId, boardId: notOn.id, access: 'read' }),
    ).rejects.toMatchObject({ code: 'not_found' });

    // Only the owner manages it.
    await call(asha, 'artifactShare', { artifactId, email: priya.email, role: 'editor' });
    await expect(
      call(priya, 'artifactBoardAccessSet', { artifactId, boardId: own.id, access: null }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await call(asha, 'artifactBoardAccessSet', { artifactId, boardId: viewOnly.id, access: null });
    expect(await boards()).toEqual({ [own.id]: 'write' });
  });
});

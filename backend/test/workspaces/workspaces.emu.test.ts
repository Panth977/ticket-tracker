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
import { claimWorkspaceOffers, WORKSPACE_OFFERS } from '../../src/commands/workspaceShared.js';
import { artifactRef } from '../../src/artifacts/shared.js';

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

  it("either side ends it: the board's admin takes their board away; nobody else can", async () => {
    const { asha, priya, ravi, vic } = await people('asha', 'priya', 'ravi', 'vic');
    const theirs = await seedBoard({ admin: priya, viewers: [asha, vic] });
    const other = await seedBoard({ admin: ravi, editors: [asha] });
    const { artifactId } = await call(asha, 'artifactCreate', { name: 'Dash' });
    const boards = async () =>
      (await db().doc(`artifacts/${artifactId}`).get()).data()!.boards as Record<string, string>;
    await call(asha, 'artifactBoardAccessSet', { artifactId, boardId: theirs.id, access: 'read' });
    await call(asha, 'artifactBoardAccessSet', { artifactId, boardId: other.id, access: 'write' });

    // Board settings › Subscribers: everyone on the board sees the artifact;
    // only the artifact's people see its name.
    const seen = await call(vic, 'boardArtifactList', { boardId: theirs.id });
    expect(seen.artifacts).toEqual([
      { artifactId, access: 'read', ownerUid: asha.uid, name: null, indicator: null },
    ]);
    const own = await call(asha, 'boardArtifactList', { boardId: theirs.id });
    expect(own.artifacts[0]).toMatchObject({ artifactId, name: 'Dash' });
    expect(own.artifacts[0]!.indicator).toBeTruthy();
    await expect(call(ravi, 'boardArtifactList', { boardId: theirs.id })).rejects.toMatchObject({
      code: 'not_found',
    });

    // A viewer of the board cannot take it away; nor can an admin of ANOTHER board.
    await expect(
      call(vic, 'artifactBoardAccessSet', { artifactId, boardId: theirs.id, access: null }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(ravi, 'artifactBoardAccessSet', { artifactId, boardId: theirs.id, access: null }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // …and a board admin only REMOVES — granting stays with the artifact's owner.
    await expect(
      call(priya, 'artifactBoardAccessSet', { artifactId, boardId: theirs.id, access: 'write' }),
    ).rejects.toMatchObject({ code: 'not_found' });

    await call(priya, 'artifactBoardAccessSet', { artifactId, boardId: theirs.id, access: null });
    expect(await boards()).toEqual({ [other.id]: 'write' });
    expect((await call(priya, 'boardArtifactList', { boardId: theirs.id })).artifacts).toEqual([]);
    // Ravi, admin of the other board, ends that one too.
    await call(ravi, 'artifactBoardAccessSet', { artifactId, boardId: other.id, access: null });
    expect(await boards()).toEqual({});
  });
});

describe('workspaceShare (one-shot)', () => {
  it('invites to every board, shares every owned artifact and bucket, copies the grouping', async () => {
    const { asha, bob, priya } = await people('asha', 'bob', 'priya');
    const mine = await seedBoard({ admin: asha });
    const theirs = await seedBoard({ admin: priya, viewers: [asha] });
    const { artifactId } = await call(asha, 'artifactCreate', { name: 'Dash' });
    const { bucketId } = await call(asha, 'bucketCreate', { name: 'Notes' });
    const { workspaceId } = await call(asha, 'workspaceCreate', {
      name: 'Client X',
      boardIds: [mine.id, theirs.id],
      artifactIds: [artifactId],
      bucketIds: [bucketId],
    });
    const stranger = `new.${Date.now()}@example.test`;

    const r = await call(asha, 'workspaceShare', {
      workspaceId,
      emails: [bob.email, stranger, asha.email],
      role: 'admin',
    });
    // Her own address is dropped; a board she may not invite to is skipped, once.
    expect(r.shared.map((s) => s.email).sort()).toEqual([bob.email, stranger].sort());
    expect(r.skipped).toEqual([expect.objectContaining({ kind: 'board', id: theirs.id })]);
    expect(r.shared.find((s) => s.email === bob.email)).toEqual({
      email: bob.email,
      boards: 1,
      artifacts: 1,
      buckets: 1,
      workspace: 'copied',
    });
    expect(r.shared.find((s) => s.email === stranger)).toMatchObject({
      boards: 1,
      workspace: 'pending',
    });

    // Each item shared the way it always is: an invite at the role, 'admin' → 'editor' elsewhere.
    const invites = await db()
      .collection(paths.invites())
      .where('boardId', '==', mine.id)
      .where('status', '==', 'pending')
      .get();
    expect(invites.docs.map((d) => [d.data().email, d.data().role]).sort()).toEqual(
      [
        [bob.email, 'admin'],
        [stranger, 'admin'],
      ].sort(),
    );
    expect((await artifactRef(artifactId).get()).data()!.access[bob.uid]).toBe('editor');
    expect((await db().doc(paths.bucket(bucketId)).get()).data()!.access[bob.uid]).toBe('editor');
    // Nothing was granted on the board yet: bob must accept the invitation.
    expect((await db().doc(paths.board(mine.id)).get()).data()!.access[bob.uid]).toBeUndefined();

    // Bob's sidebar copy; sharing again refreshes it rather than adding another.
    const copies = async () => (await db().collection(paths.workspaces(bob.uid)).get()).docs;
    expect((await copies()).map((d) => d.data())).toEqual([
      expect.objectContaining({
        name: 'Client X',
        boardIds: [mine.id, theirs.id],
        artifactIds: [artifactId],
      }),
    ]);
    await call(asha, 'workspaceUpdate', { workspaceId, name: 'Client X (2025)' });
    await call(asha, 'workspaceShare', { workspaceId, emails: [bob.email], role: 'viewer' });
    expect((await copies()).map((d) => d.data().name)).toEqual(['Client X (2025)']);

    // The stranger's copy waits for their account, then becomes theirs.
    const offers = await db().collection(WORKSPACE_OFFERS).where('email', '==', stranger).get();
    expect(offers.size).toBe(1);
    await claimWorkspaceOffers('newcomer-uid', stranger, Date.now());
    expect(
      (await db().collection(paths.workspaces('newcomer-uid')).get()).docs[0]!.data(),
    ).toMatchObject({
      name: 'Client X',
      position: 0,
    });
    expect(
      (await db().collection(WORKSPACE_OFFERS).where('email', '==', stranger).get()).size,
    ).toBe(0);
  });

  it('only the owner, only a person, a real workspace', async () => {
    const { asha, bob } = await people('asha', 'bob');
    const { workspaceId } = await call(asha, 'workspaceCreate', { name: 'Mine' });
    await expect(
      call(bob, 'workspaceShare', { workspaceId, emails: [asha.email], role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      call(asha, 'workspaceShare', { workspaceId, emails: [asha.email], role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

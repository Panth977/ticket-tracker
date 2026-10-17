/**
 * Owners and orgs (agents.html §AC): handles, org membership by invite, the
 * fan-out of an org's roles onto everything it owns, transfers, and the
 * owner-first URLs (pathResolve).
 */
import { describe, expect, it } from 'vitest';
import { paths } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { artifactRef } from '../../src/artifacts/shared.js';
import { bucketRef } from '../../src/bucket/shared.js';
import { ensureUserHandle } from '../../src/org/shared.js';
import { call, setupEmulators, uniq } from '../harness/index.js';
import { people } from '../tickets/helpers.js';

setupEmulators();

const board = async (id: string) => (await db().doc(paths.board(id)).get()).data()!;
const handle = () =>
  `o-${uniq('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(-10)}`;

async function joinOrg(
  admin: Parameters<typeof call>[0],
  orgId: string,
  who: { email: string } & Parameters<typeof call>[0],
  role: 'owner' | 'admin' | 'member',
) {
  await call(admin, 'orgInvite', { orgId, invites: [{ email: who.email, role }] });
  const inv = await db()
    .collection(paths.invites())
    .where('orgId', '==', orgId)
    .where('email', '==', who.email.toLowerCase())
    .where('status', '==', 'pending')
    .get();
  return call(who, 'inviteAccept', { inviteId: inv.docs[0]!.id, accept: true });
}

describe('orgs (§AC)', () => {
  it('create, handle taken, members by invite, base role fans out to everything the org owns', async () => {
    const { asha, ben, cy } = await people('asha', 'ben', 'cy');
    const h = handle();
    const { orgId } = await call(asha, 'orgCreate', {
      handle: h,
      name: 'Acme',
      baseRole: 'viewer',
    });
    await expect(call(ben, 'orgCreate', { handle: h, name: 'Other' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(call(asha, 'orgCreate', { handle: 'login', name: 'X' })).rejects.toMatchObject({
      code: 'invalid',
    });

    const key = `A${uniq('')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(-5)}`;
    const { boardId } = await call(asha, 'boardCreate', {
      name: 'Ops',
      key,
      owner: { kind: 'org', id: orgId },
    });
    const { artifactId } = await call(asha, 'artifactCreate', {
      name: 'Dash',
      owner: { kind: 'org', id: orgId },
    });
    const { bucketId } = await call(asha, 'bucketCreate', {
      name: 'Files',
      owner: { kind: 'org', id: orgId },
    });
    expect((await board(boardId)).owner).toEqual({ kind: 'org', id: orgId });

    const r = await joinOrg(asha, orgId, ben, 'member');
    expect(r).toMatchObject({ orgId, orgHandle: h });
    // Ben reaches everything at the base role, through the very maps every check reads.
    expect((await board(boardId)).access[ben.uid]).toBe('viewer');
    expect((await board(boardId)).readerUids).toContain(ben.uid);
    expect((await db().doc(paths.member(boardId, ben.uid)).get()).exists).toBe(true);
    expect((await artifactRef(artifactId).get()).data()!.access[ben.uid]).toBe('viewer');
    expect((await bucketRef(bucketId).get()).data()!.access[ben.uid]).toBe('viewer');

    // The base role goes up: everyone's follows.
    await call(asha, 'orgUpdate', { orgId, baseRole: 'editor' });
    expect((await board(boardId)).access[ben.uid]).toBe('editor');
    expect((await artifactRef(artifactId).get()).data()!.access[ben.uid]).toBe('editor');

    // An admin of the org is an admin of its boards and an owner of its artifacts / buckets.
    await joinOrg(asha, orgId, cy, 'admin');
    expect((await board(boardId)).access[cy.uid]).toBe('admin');
    expect((await bucketRef(bucketId).get()).data()!.access[cy.uid]).toBe('owner');

    // Members cannot manage the org.
    await expect(call(ben, 'orgUpdate', { orgId, name: 'Mine' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    // An org always keeps an owner.
    await expect(
      call(asha, 'orgMemberSet', { orgId, uid: asha.uid, role: null }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });

    // Leaving takes away what the org gave — and only that.
    await call(ben, 'orgMemberSet', { orgId, uid: ben.uid, role: null });
    expect((await board(boardId)).access[ben.uid]).toBeUndefined();
    expect((await db().doc(paths.member(boardId, ben.uid)).get()).exists).toBe(false);
    expect((await artifactRef(artifactId).get()).data()!.access[ben.uid]).toBeUndefined();

    // An org that owns things cannot be deleted.
    await expect(call(asha, 'orgDelete', { orgId })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a direct role survives leaving the org; a higher org role wins while there', async () => {
    const { asha, ben } = await people('asha', 'ben');
    const { orgId } = await call(asha, 'orgCreate', {
      handle: handle(),
      name: 'Beta',
      baseRole: 'viewer',
    });
    const key = `B${uniq('')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(-5)}`;
    const { boardId } = await call(asha, 'boardCreate', {
      name: 'Eng',
      key,
      owner: { kind: 'org', id: orgId },
    });
    // Ben is a direct editor first.
    await call(asha, 'inviteCreate', { boardId, invites: [{ email: ben.email, role: 'editor' }] });
    const inv = await db()
      .collection(paths.invites())
      .where('boardId', '==', boardId)
      .where('email', '==', ben.email.toLowerCase())
      .get();
    await call(ben, 'inviteAccept', { inviteId: inv.docs[0]!.id, accept: true });
    await joinOrg(asha, orgId, ben, 'member');
    expect((await board(boardId)).access[ben.uid]).toBe('editor'); // viewer from the org < editor
    await call(ben, 'orgMemberSet', { orgId, uid: ben.uid, role: null });
    expect((await board(boardId)).access[ben.uid]).toBe('editor'); // still theirs
  });

  it('transfer to and from an org; pathResolve names the thing by owner and slug', async () => {
    const { asha, ben } = await people('asha', 'ben');
    const h = handle();
    const { orgId } = await call(asha, 'orgCreate', {
      handle: h,
      name: 'Gamma',
      baseRole: 'editor',
    });
    await joinOrg(asha, orgId, ben, 'member');
    const { artifactId } = await call(asha, 'artifactCreate', { name: 'Sales Dash' });
    const mine = await ensureUserHandle(asha.uid);
    expect((await artifactRef(artifactId).get()).data()).toMatchObject({
      owner: { kind: 'user', id: asha.uid },
      slug: 'sales-dash',
    });
    const at = await call(asha, 'pathResolve', {
      handle: mine,
      kind: 'artifact',
      slug: 'sales-dash',
    });
    expect(at.thing).toEqual({ kind: 'artifact', id: artifactId, slug: 'sales-dash' });
    await expect(
      call(ben, 'pathResolve', { handle: mine, kind: 'artifact', slug: 'sales-dash' }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });

    // Members may not move things into the org; its admins (and owners) may.
    await expect(
      call(ben, 'ownerTransfer', {
        thing: { kind: 'artifact', id: artifactId },
        to: { kind: 'org', id: orgId },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const moved = await call(asha, 'ownerTransfer', {
      thing: { kind: 'artifact', id: artifactId },
      to: { kind: 'org', id: orgId },
    });
    expect(moved).toMatchObject({ owner: { kind: 'org', id: orgId }, handle: h });
    expect((await artifactRef(artifactId).get()).data()!.access[ben.uid]).toBe('editor');
    const there = await call(ben, 'pathResolve', {
      handle: h,
      kind: 'artifact',
      slug: 'sales-dash',
    });
    expect(there.thing?.id).toBe(artifactId);

    // Back to Asha: the org's grants go with it.
    await call(asha, 'ownerTransfer', {
      thing: { kind: 'artifact', id: artifactId },
      to: { kind: 'user', id: asha.uid },
    });
    expect((await artifactRef(artifactId).get()).data()!.access[ben.uid]).toBeUndefined();
  });

  it('transfer to another person, like a GitHub repo: they own it, the mover stays', async () => {
    const { asha, ben, cy } = await people('asha', 'ben', 'cy');
    const key = `T${uniq('')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(-5)}`;
    const { boardId } = await call(asha, 'boardCreate', { name: 'Ops', key });
    const { artifactId } = await call(asha, 'artifactCreate', { name: 'Wall' });
    const { bucketId } = await call(asha, 'bucketCreate', { name: 'Kit' });
    const bens = await ensureUserHandle(ben.uid);

    // Only whoever fully manages it may give it away.
    await expect(
      call(cy, 'ownerTransfer', {
        thing: { kind: 'artifact', id: artifactId },
        to: { kind: 'user', id: cy.uid },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Never to somebody who is not there.
    await expect(
      call(asha, 'ownerTransfer', {
        thing: { kind: 'board', id: boardId },
        to: { kind: 'user', id: 'u_nobody_here' },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    for (const [kind, id] of [
      ['board', boardId],
      ['artifact', artifactId],
      ['bucket', bucketId],
    ] as const) {
      const r = await call(asha, 'ownerTransfer', {
        thing: { kind, id },
        to: { kind: 'user', id: ben.uid },
      });
      expect(r).toMatchObject({ owner: { kind: 'user', id: ben.uid }, handle: bens });
    }
    const b = await board(boardId);
    expect(b).toMatchObject({ ownerKey: `user:${ben.uid}`, ownerHandle: bens });
    expect(b.access).toMatchObject({ [asha.uid]: 'admin', [ben.uid]: 'admin' });
    expect(b.readerUids).toContain(ben.uid);
    expect((await db().doc(paths.member(boardId, ben.uid)).get()).data()).toMatchObject({
      role: 'admin',
    });
    const a = (await artifactRef(artifactId).get()).data()!;
    expect(a).toMatchObject({ ownerUid: ben.uid, ownerKey: `user:${ben.uid}`, slug: 'wall' });
    expect(a.access).toMatchObject({ [asha.uid]: 'owner', [ben.uid]: 'owner' });
    const m = (await bucketRef(bucketId).get()).data()!;
    expect(m).toMatchObject({ ownerUid: ben.uid, ownerKey: `user:${ben.uid}` });
    expect(m.memberUids).toContain(ben.uid);
    // It now lives at Ben's address.
    const at = await call(ben, 'pathResolve', { handle: bens, kind: 'artifact', slug: 'wall' });
    expect(at.thing?.id).toBe(artifactId);
    // And Ben, its owner now, may give it back.
    await call(ben, 'ownerTransfer', {
      thing: { kind: 'artifact', id: artifactId },
      to: { kind: 'user', id: asha.uid },
    });
    expect((await artifactRef(artifactId).get()).data()).toMatchObject({ ownerUid: asha.uid });
  });
});

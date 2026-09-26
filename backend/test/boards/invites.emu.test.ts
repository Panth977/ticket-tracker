import { describe, expect, it } from 'vitest';
import { paths, rateBuckets, rtdb, type InboxItem, type Invite } from '@tm/shared';
import { db, rtdbAdmin } from '../../src/runtime/firebase.js';
import { devOutbox, fixedClock, setPorts, setupEmulators } from '../harness/index.js';
import {
  addMember,
  call,
  createUser,
  getBoard,
  getMember,
  newBoard,
  readers,
  uniq,
} from './helpers.js';

setupEmulators();

const email = (name = 'inv') => `${name}.${uniq()}@test.dev`.toLowerCase();

async function invitesFor(boardId: string, addr: string) {
  const s = await db()
    .collection(paths.invites())
    .where('boardId', '==', boardId)
    .where('email', '==', addr)
    .get();
  return s.docs.map((d) => ({ id: d.id, ...(d.data() as Invite) }));
}

/** The latest invite link sent to `addr`: { inviteId, token }. */
async function lastLink(addr: string): Promise<{ inviteId: string; token: string }> {
  const mail = await devOutbox<{ text: string }>('mail', { field: 'to', equals: addr });
  const m = /\/invite\/([^.\s]+)\.(\S+)/.exec(mail[mail.length - 1]!.text)!;
  return { inviteId: m[1]!, token: m[2]! };
}

describe('inviteCreate', () => {
  it('creates a pending invite (hashed token), mails it, and reports people already on the board', async () => {
    const alice = await createUser({ name: 'Alice' });
    const bob = await createUser();
    const { boardId, key } = await newBoard(alice);
    await addMember(boardId, bob, 'editor');
    const newbie = email('newbie');

    const res = await call(alice, 'inviteCreate', {
      boardId,
      invites: [
        { email: newbie.toUpperCase(), role: 'editor' },
        { email: bob.email, role: 'viewer' },
      ],
      message: 'Welcome aboard',
    });
    expect(res).toEqual({ invited: [newbie], alreadyOnBoard: [bob.email] });

    const [inv] = await invitesFor(boardId, newbie);
    expect(inv).toMatchObject({
      boardName: 'Engineering',
      boardKey: key,
      role: 'editor',
      invitedBy: alice.uid,
      invitedByName: 'Alice',
      message: 'Welcome aboard',
      status: 'pending',
    });
    const { inviteId, token } = await lastLink(newbie);
    expect(inviteId).toBe(inv!.id);
    expect(inv!.tokenHash).not.toContain(token);
    const mail = await devOutbox<{ subject: string; text: string }>('mail', {
      field: 'to',
      equals: newbie,
    });
    expect(mail[0]!.subject).toBe('Alice invited you to Engineering');
    expect(mail[0]!.text).toContain(alice.email); // the inviter's verified address
  });

  it('a pending invite is refreshed, not duplicated', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const addr = email();
    await call(alice, 'inviteCreate', { boardId, invites: [{ email: addr, role: 'viewer' }] });
    const first = await lastLink(addr);
    await call(alice, 'inviteCreate', { boardId, invites: [{ email: addr, role: 'editor' }] });
    const invs = await invitesFor(boardId, addr);
    expect(invs).toHaveLength(1);
    expect(invs[0]!.role).toBe('editor');
    const second = await lastLink(addr);
    expect(second.inviteId).toBe(first.inviteId);
    expect(second.token).not.toBe(first.token);
  });

  it('an existing account also gets an invited inbox row', async () => {
    const alice = await createUser({ name: 'Alice' });
    const carol = await createUser();
    const { boardId } = await newBoard(alice);
    await call(alice, 'inviteCreate', {
      boardId,
      invites: [{ email: carol.email, role: 'commenter' }],
    });
    const [inv] = await invitesFor(boardId, carol.email);
    const row = (
      await db()
        .doc(paths.inboxItem(carol.uid, `invite_${inv!.id}`))
        .get()
    ).data() as InboxItem;
    expect(row).toMatchObject({
      event: 'invited',
      boardId,
      inviteId: inv!.id,
      actor: alice.uid,
      ticketId: null,
      summary: 'Alice invited you to Engineering as a commenter',
      readAt: null,
    });
  });

  it('permissions: admins; editors only with editorsCanInvite and never as admin; others 403, strangers 404', async () => {
    const alice = await createUser();
    const ed = await createUser();
    const v = await createUser();
    const eve = await createUser();
    const { boardId } = await newBoard(alice);
    await addMember(boardId, ed, 'editor');
    await addMember(boardId, v, 'viewer');
    const inv = { boardId, invites: [{ email: email(), role: 'viewer' as const }] };
    await expect(call(ed, 'inviteCreate', inv)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(call(v, 'inviteCreate', inv)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(call(eve, 'inviteCreate', inv)).rejects.toMatchObject({ code: 'not_found' });
    await call(alice, 'boardUpdate', { boardId, patch: { settings: { editorsCanInvite: true } } });
    await expect(call(ed, 'inviteCreate', inv)).resolves.toMatchObject({
      invited: [inv.invites[0]!.email],
    });
    await expect(
      call(ed, 'inviteCreate', { boardId, invites: [{ email: email(), role: 'admin' }] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('50 invites per person per day → 429', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const day = Math.floor(Date.now() / 86_400_000);
    await rtdbAdmin()
      .ref(rtdb.rate(rateBuckets.invites(alice.uid), day))
      .set(49);
    await expect(
      call(alice, 'inviteCreate', {
        boardId,
        invites: [
          { email: email(), role: 'viewer' },
          { email: email(), role: 'viewer' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(
      call(alice, 'inviteCreate', { boardId, invites: [{ email: email(), role: 'viewer' }] }),
    ).resolves.toBeTruthy();
  });
});

describe('inviteAccept', () => {
  it('token accept: role granted, member row, mirror, invite accepted', async () => {
    const alice = await createUser();
    const addr = email('asha');
    const { boardId, key } = await newBoard(alice);
    await call(alice, 'inviteCreate', { boardId, invites: [{ email: addr, role: 'editor' }] });
    const { inviteId, token } = await lastLink(addr);
    const asha = await createUser({ name: 'Asha', email: addr });

    expect(await call(asha, 'inviteAccept', { inviteId, token, accept: true })).toEqual({
      boardId,
      boardKey: key,
    });
    const b = (await getBoard(boardId))!;
    expect(b.access[asha.uid]).toBe('editor');
    expect(b.editorUids).toContain(asha.uid);
    expect(await getMember(boardId, asha.uid)).toMatchObject({
      role: 'editor',
      name: 'Asha',
      email: addr,
      invitedBy: alice.uid,
    });
    expect((await readers(boardId))![asha.uid]).toBe(true);
    expect((await db().doc(paths.invite(inviteId)).get()).data()).toMatchObject({
      status: 'accepted',
    });
    // Accepting again: 410.
    await expect(
      call(asha, 'inviteAccept', { inviteId, token, accept: true }),
    ).rejects.toMatchObject({
      code: 'gone',
    });
  });

  it('inbox accept (no token) marks the row done', async () => {
    const alice = await createUser();
    const carol = await createUser();
    const { boardId } = await newBoard(alice);
    await call(alice, 'inviteCreate', {
      boardId,
      invites: [{ email: carol.email, role: 'viewer' }],
    });
    const [inv] = await invitesFor(boardId, carol.email);
    await call(carol, 'inviteAccept', { inviteId: inv!.id, accept: true });
    const row = (
      await db()
        .doc(paths.inboxItem(carol.uid, `invite_${inv!.id}`))
        .get()
    ).data()!;
    expect(row.archivedAt).toEqual(expect.any(Number));
    expect((await getBoard(boardId))!.access[carol.uid]).toBe('viewer');
  });

  it('wrong token 404; wrong or unverified account 403 (a forwarded link)', async () => {
    const alice = await createUser();
    const addr = email('target');
    const { boardId } = await newBoard(alice);
    await call(alice, 'inviteCreate', { boardId, invites: [{ email: addr, role: 'editor' }] });
    const { inviteId, token } = await lastLink(addr);

    const other = await createUser();
    await expect(
      call(other, 'inviteAccept', { inviteId, token, accept: true }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      details: { invitedEmail: expect.stringContaining('***@test.dev') },
    });
    const unverified = await createUser({ email: addr, emailVerified: false });
    await expect(
      call(unverified, 'inviteAccept', { inviteId, token, accept: true }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(unverified, 'inviteAccept', { inviteId, token: 'bad-token', accept: true }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await getBoard(boardId))!.readerUids).toEqual([alice.uid]);
  });

  it('decline → declined, nobody added', async () => {
    const alice = await createUser();
    const carol = await createUser();
    const { boardId } = await newBoard(alice);
    await call(alice, 'inviteCreate', {
      boardId,
      invites: [{ email: carol.email, role: 'viewer' }],
    });
    const [inv] = await invitesFor(boardId, carol.email);
    await call(carol, 'inviteAccept', { inviteId: inv!.id, accept: false });
    expect((await db().doc(paths.invite(inv!.id)).get()).data()).toMatchObject({
      status: 'declined',
    });
    expect((await getBoard(boardId))!.access[carol.uid]).toBeUndefined();
  });

  it('expired → 410', async () => {
    const alice = await createUser();
    const carol = await createUser();
    const { boardId } = await newBoard(alice);
    await call(alice, 'inviteCreate', {
      boardId,
      invites: [{ email: carol.email, role: 'viewer' }],
    });
    const [inv] = await invitesFor(boardId, carol.email);
    setPorts({ clock: fixedClock(Date.now() + 15 * 86_400_000) });
    await expect(
      call(carol, 'inviteAccept', { inviteId: inv!.id, accept: true }),
    ).rejects.toMatchObject({
      code: 'gone',
    });
  });

  it('never downgrades someone already on the board', async () => {
    const alice = await createUser();
    const carol = await createUser();
    const { boardId } = await newBoard(alice);
    await call(alice, 'inviteCreate', {
      boardId,
      invites: [{ email: carol.email, role: 'viewer' }],
    });
    const [inv] = await invitesFor(boardId, carol.email);
    await addMember(boardId, carol, 'editor');
    await call(carol, 'inviteAccept', { inviteId: inv!.id, accept: true });
    expect((await getBoard(boardId))!.access[carol.uid]).toBe('editor');
  });
});

describe('inviteRevoke', () => {
  it('revoke: link and inbox row stop working', async () => {
    const alice = await createUser();
    const carol = await createUser();
    const { boardId } = await newBoard(alice);
    await call(alice, 'inviteCreate', {
      boardId,
      invites: [{ email: carol.email, role: 'viewer' }],
    });
    const { inviteId, token } = await lastLink(carol.email);
    await call(alice, 'inviteRevoke', { inviteId });
    expect((await db().doc(paths.invite(inviteId)).get()).data()).toMatchObject({
      status: 'revoked',
    });
    const row = (
      await db()
        .doc(paths.inboxItem(carol.uid, `invite_${inviteId}`))
        .get()
    ).data()!;
    expect(row.archivedAt).toEqual(expect.any(Number));
    await expect(
      call(carol, 'inviteAccept', { inviteId, token, accept: true }),
    ).rejects.toMatchObject({
      code: 'gone',
    });
    await expect(call(alice, 'inviteRevoke', { inviteId })).rejects.toMatchObject({ code: 'gone' });
  });

  it('resend: new token (old link dead), new expiry, mailed again', async () => {
    const alice = await createUser();
    const addr = email();
    const { boardId } = await newBoard(alice);
    await call(alice, 'inviteCreate', { boardId, invites: [{ email: addr, role: 'viewer' }] });
    const first = await lastLink(addr);
    await call(alice, 'inviteRevoke', { inviteId: first.inviteId, resend: true });
    const second = await lastLink(addr);
    expect(second.inviteId).toBe(first.inviteId);
    expect(second.token).not.toBe(first.token);
    const u = await createUser({ email: addr });
    await expect(
      call(u, 'inviteAccept', { inviteId: first.inviteId, token: first.token, accept: true }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await call(u, 'inviteAccept', { inviteId: second.inviteId, token: second.token, accept: true });
  });

  it('the inviter or an admin; other members 403, strangers 404', async () => {
    const alice = await createUser();
    const ed = await createUser();
    const v = await createUser();
    const eve = await createUser();
    const { boardId } = await newBoard(alice, {});
    await addMember(boardId, ed, 'editor');
    await addMember(boardId, v, 'viewer');
    await call(alice, 'boardUpdate', { boardId, patch: { settings: { editorsCanInvite: true } } });
    const addr = email();
    await call(ed, 'inviteCreate', { boardId, invites: [{ email: addr, role: 'viewer' }] });
    const { inviteId } = await lastLink(addr);
    await expect(call(v, 'inviteRevoke', { inviteId })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(call(eve, 'inviteRevoke', { inviteId })).rejects.toMatchObject({
      code: 'not_found',
    });
    await call(ed, 'inviteRevoke', { inviteId, resend: true });
    await call(alice, 'inviteRevoke', { inviteId });
  });
});

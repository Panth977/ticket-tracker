import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { UserRecord } from 'firebase-admin/auth';
import { paths, type InboxItem, type User } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { autoload } from '../../src/runtime/autoload.js';
import { getTrigger } from '../../src/runtime/functions.js';
import { handleUserCreated } from '../../src/triggers/authUserCreated.js';
import { ports, setupEmulators } from '../harness/index.js';
import { call, createUser, getMember, newBoard, uniq } from './helpers.js';

setupEmulators();

const user = async (uid: string) =>
  (await db().doc(paths.user(uid)).get()).data() as User | undefined;
const record = (over: Partial<UserRecord>): UserRecord =>
  ({
    uid: uniq('u'),
    email: undefined,
    emailVerified: false,
    displayName: undefined,
    photoURL: undefined,
    ...over,
  }) as UserRecord;

describe('onUserCreated', () => {
  it('registers both auth triggers', async () => {
    await autoload();
    expect(getTrigger('onUserCreated')).toBeTypeOf('function');
    expect(getTrigger('beforeUserSignedIn')).toBeTypeOf('function');
  });

  it('creates users/{uid} with defaults; never overwrites an existing doc', async () => {
    const r = record({
      displayName: 'Asha Rao',
      email: `Asha.${uniq()}@Test.dev`,
      emailVerified: true,
    });
    await handleUserCreated(r);
    const u = (await user(r.uid))!;
    expect(u).toMatchObject({
      name: 'Asha Rao',
      email: r.email!.toLowerCase(),
      avatarPath: null,
      timezone: 'UTC',
      theme: 'system',
      whatsapp: null,
      deletedAt: null,
      notify: { digest: 'off', dueSoonLeadMinutes: 1440 },
    });
    await db().doc(paths.user(r.uid)).update({ name: 'Changed' });
    await handleUserCreated(r); // redelivered
    expect((await user(r.uid))!.name).toBe('Changed');
  });

  it('copies the provider photo into our own avatar path (256px webp)', async () => {
    const png = await sharp({
      create: { width: 600, height: 400, channels: 3, background: '#3366ff' },
    })
      .png()
      .toBuffer();
    const fakeFetch = (async () =>
      new Response(new Uint8Array(png), {
        headers: { 'content-type': 'image/png' },
      })) as typeof fetch;
    const r = record({
      displayName: 'G',
      email: `g.${uniq()}@test.dev`,
      photoURL: 'https://lh3.googleusercontent.com/x',
    });
    await handleUserCreated(r, fakeFetch);
    const u = (await user(r.uid))!;
    expect(u.avatarPath).toMatch(new RegExp(`^users/${r.uid}/avatar/\\d+\\.webp$`));
    const meta = await sharp(Buffer.from(await ports().files.read(u.avatarPath!))).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 256, height: 256 });

    // A broken photo never fails the sign-up.
    const r2 = record({ email: `h.${uniq()}@test.dev`, photoURL: 'https://example.invalid/x' });
    const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await handleUserCreated(r2, failing);
    expect((await user(r2.uid))!.avatarPath).toBeNull();
  });

  it('pending invites for a verified address become inbox rows', async () => {
    const alice = await createUser({ name: 'Alice' });
    const { boardId } = await newBoard(alice);
    const addr = `later.${uniq()}@test.dev`;
    await call(alice, 'inviteCreate', { boardId, invites: [{ email: addr, role: 'editor' }] });
    const r = record({ email: addr, emailVerified: true });
    await handleUserCreated(r);
    const rows = (await db().collection(paths.inbox(r.uid)).get()).docs.map(
      (d) => d.data() as InboxItem,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        event: 'invited',
        boardId,
        summary: 'Alice invited you to Engineering as an editor',
      }),
    ]);
    // Unverified: nothing yet.
    const addr2 = `unv.${uniq()}@test.dev`;
    await call(alice, 'inviteCreate', { boardId, invites: [{ email: addr2, role: 'viewer' }] });
    const r2 = record({ email: addr2, emailVerified: false });
    await handleUserCreated(r2);
    expect((await db().collection(paths.inbox(r2.uid)).get()).size).toBe(0);
  });
});

describe('onUserSignedIn (beforeUserSignedIn)', () => {
  it('a changed verified e-mail is copied to users/ and every members/ row; invites attached', async () => {
    await autoload();
    const alice = await createUser({ name: 'Alice' });
    const { boardId } = await newBoard(alice);
    await call(alice, 'profileUpdate', { theme: 'light' }); // ensure users/ exists
    const next = `alice.new.${uniq()}@test.dev`;
    const inviter = await createUser({ name: 'Bob' });
    const ob = await newBoard(inviter);
    await call(inviter, 'inviteCreate', {
      boardId: ob.boardId,
      invites: [{ email: next, role: 'viewer' }],
    });

    const handler = getTrigger('beforeUserSignedIn')!;
    await handler({ data: { uid: alice.uid, email: next, emailVerified: true } } as never);

    expect((await user(alice.uid))!.email).toBe(next);
    expect((await getMember(boardId, alice.uid))!.email).toBe(next);
    const rows = (await db().collection(paths.inbox(alice.uid)).get()).docs.map((d) => d.data());
    expect(rows).toEqual([expect.objectContaining({ event: 'invited', boardId: ob.boardId })]);

    // Unverified change: ignored.
    await handler({ data: { uid: alice.uid, email: 'x@y.dev', emailVerified: false } } as never);
    expect((await user(alice.uid))!.email).toBe(next);
  });
});

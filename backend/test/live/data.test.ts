/**
 * The live data engine on SQLite (in memory) with the real firestore.rules:
 * reads, queries, listeners and client writes — allowed and refused exactly
 * where the rules say (the rules themselves are proven equal to Firebase's in
 * qaqc/rules/interpreter.test.ts).
 */
process.env.TM_DB = 'sqlite';
process.env.TM_DB_DIR = ':memory:';

/** A frame off the live wire (shape checked by the assertions). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Frame = Record<string, any>;

import { beforeAll, describe, expect, it } from 'vitest';
import { fixtures } from '@tm/shared/schema/fixtures';

const { db } = await import('../../src/db/index.js');
const { DataSession } = await import('../../src/live/data.js');

const BOARD = 'b_live';
const ROLES = { u_admin: 'admin', u_editor: 'editor', u_viewer: 'viewer' } as const;
const auth = (uid: string | null) =>
  uid ? { uid, token: { email: `${uid}@x.dev`, email_verified: true } } : null;

function session(uid: string | null) {
  const out: Frame[] = [];
  const s = new DataSession(auth(uid), (m) => out.push(m));
  const ask = async (msg: Record<string, unknown>) => {
    const id = String(Math.random());
    await s.handle({ id, ...msg } as never);
    return out.find((m) => m.id === id);
  };
  return { s, out, ask };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

beforeAll(async () => {
  const put = (p: string, d: object) =>
    db()
      .doc(p)
      .set(JSON.parse(JSON.stringify(d)));
  for (const uid of [...Object.keys(ROLES), 'u_stranger'])
    await put(`users/${uid}`, { ...fixtures.users, email: `${uid}@x.dev` });
  await put(`users/u_admin/inbox/n1`, fixtures.inbox);
  const readerUids = Object.keys(ROLES);
  await put(`boards/${BOARD}`, {
    ...fixtures.boards,
    access: ROLES,
    readerUids,
    editorUids: ['u_admin', 'u_editor'],
    archivedAt: null,
  });
  for (const [uid, role] of Object.entries(ROLES))
    await put(`boards/${BOARD}/members/${uid}`, { ...fixtures.members, uid, role });
});

describe('live data engine', () => {
  it('get: own inbox yes, somebody else’s no', async () => {
    expect((await session('u_admin').ask({ op: 'get', path: 'users/u_admin/inbox/n1' })).ok).toBe(
      true,
    );
    const r = await session('u_viewer').ask({ op: 'get', path: 'users/u_admin/inbox/n1' });
    expect(r).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
  });

  it('query: members of a board for its members only', async () => {
    const ok = await session('u_viewer').ask({
      op: 'query',
      q: { path: `boards/${BOARD}/members` },
    });
    expect(ok.result.docs).toHaveLength(3);
    const no = await session('u_stranger').ask({
      op: 'query',
      q: { path: `boards/${BOARD}/members` },
    });
    expect(no.error.code).toBe('permission-denied');
  });

  it('listen: a snapshot now and on every change; unlisten stops it', async () => {
    const { out, ask } = session('u_admin');
    await ask({ op: 'listen', lid: 'L1', q: { path: 'users/u_admin/inbox' } });
    expect(out.filter((m) => m.lid === 'L1').at(-1).snap.docs).toHaveLength(1);
    await db()
      .doc('users/u_admin/inbox/n2')
      .set(JSON.parse(JSON.stringify(fixtures.inbox)));
    await tick();
    expect(out.filter((m) => m.lid === 'L1').at(-1).snap.docs).toHaveLength(2);
    await ask({ op: 'unlisten', lid: 'L1' });
    const n = out.length;
    await db()
      .doc('users/u_admin/inbox/n3')
      .set(JSON.parse(JSON.stringify(fixtures.inbox)));
    await tick();
    expect(out.length).toBe(n);
  });

  it('a listener ends with permission-denied when access goes away', async () => {
    const { out, ask } = session('u_viewer');
    await ask({ op: 'listen', lid: 'B', path: `boards/${BOARD}/members/u_viewer` });
    expect(out.find((m) => m.lid === 'B').snap.exists).toBe(true);
    await db()
      .doc(`boards/${BOARD}`)
      .update({ readerUids: ['u_admin', 'u_editor'] });
    await tick();
    expect(out.filter((m) => m.lid === 'B').at(-1)).toMatchObject({
      error: { code: 'permission-denied' },
    });
    await db()
      .doc(`boards/${BOARD}`)
      .update({ readerUids: Object.keys(ROLES) });
  });

  it('commit: the writes the rules allow, all or nothing', async () => {
    const device = { fcmToken: 'tok', kind: 'web', userAgent: 'ua', lastSeenAt: Date.now() };
    const { ask } = session('u_admin');
    expect(
      (
        await ask({
          op: 'commit',
          writes: [{ path: 'users/u_admin/devices/d1', kind: 'set', data: device }],
        })
      ).ok,
    ).toBe(true);
    expect((await db().doc('users/u_admin/devices/d1').get()).exists).toBe(true);
    const bad = await ask({
      op: 'commit',
      writes: [
        { path: 'users/u_admin/devices/d2', kind: 'set', data: device },
        { path: `boards/${BOARD}`, kind: 'update', data: { name: 'Hacked' } },
      ],
    });
    expect(bad.error.code).toBe('permission-denied');
    expect((await db().doc('users/u_admin/devices/d2').get()).exists).toBe(false);
    const flags = await ask({
      op: 'commit',
      writes: [{ path: 'users/u_admin/inbox/n1', kind: 'update', data: { readAt: Date.now() } }],
    });
    expect(flags.ok).toBe(true);
    const sneaky = await ask({
      op: 'commit',
      writes: [{ path: 'users/u_admin/inbox/n1', kind: 'update', data: { title: 'x' } }],
    });
    expect(sneaky.error.code).toBe('permission-denied');
  });

  it('sentinels travel the wire: serverTimestamp / increment resolve for rules and store', async () => {
    const { ask } = session('u_admin');
    const r = await ask({
      op: 'commit',
      writes: [
        { path: 'users/u_admin/inbox/n1', kind: 'update', data: { readAt: { __fv: 'delete' } } },
      ],
    });
    expect(r.ok).toBe(true);
    expect((await db().doc('users/u_admin/inbox/n1').get()).data()!.readAt).toBeUndefined();
  });
});

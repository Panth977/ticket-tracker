/**
 * ICEBASE'S RULES ENGINE AGAINST THE REAL THING.
 *
 * On the IceBase server (TM_ICEBASE=emulator) there is no Firestore to enforce firestore.rules:
 * IceBase interprets the very same file. This suite asks the Firestore emulator (loaded with
 * backend/firestore.rules) and IceBase's engine the same questions — every seeded document, read
 * by every person (and by nobody), plus the client writes the rules allow and the near-misses
 * they refuse — and requires the same answer to each.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { fixtures } from '@tm/shared/schema/fixtures';
import { loadRules } from '@panth977/icebase-cli/internal';
import {
  ADMIN,
  BOARD,
  COMMENTER,
  EDITOR,
  EVERYONE,
  MEMBERS,
  OTHER_BOARD,
  ROLES,
  STRANGER,
  TICKET,
  VIEWER,
  as,
  boardDoc,
  emailOf,
  fs,
  makeEnv,
  readRules,
} from './_env.js';

let env: RulesTestEnvironment;
const rules = loadRules(readRules('firestore.rules'), 'firestore');
const T = `boards/${BOARD}/tickets/${TICKET}`;
const REFUSED = 'u_refused';

/** What is in the database, for both sides. */
const seed = new Map<string, Record<string, unknown>>();
const put = (path: string, data: Record<string, unknown>) =>
  seed.set(path, JSON.parse(JSON.stringify(data)));

for (const uid of EVERYONE) put(`users/${uid}`, { ...fixtures.users, email: emailOf(uid) });
put(`users/${REFUSED}`, { ...fixtures.users, email: emailOf(REFUSED), allowed: false });
put(`users/${ADMIN}/devices/d1`, fixtures.devices);
put(`users/${ADMIN}/inbox/n1`, fixtures.inbox);
put(`users/${ADMIN}/reads/${TICKET}`, fixtures.reads);
put(`users/${ADMIN}/apiKeys/k1`, fixtures.apiKeys);
put(`users/${ADMIN}/oauthGrants/g1`, fixtures.oauthGrants);
put('invites/inv_stranger', { ...fixtures.invites, boardId: BOARD, email: emailOf(STRANGER) });
put('boardKeys/ENG', fixtures.boardKeys);
put('keys/ENG-1', fixtures.keys);
put('deliveries/dl_viewer', { ...fixtures.deliveries, uid: VIEWER });
put('oauthClients/c1', fixtures.oauthClients);
put(`_idem/${ADMIN}_c1`, { at: 0 });
put(`boards/${BOARD}`, { ...fixtures.boards, ...boardDoc(ROLES) });
put(`boards/${OTHER_BOARD}`, {
  ...fixtures.boards,
  ...boardDoc({ [STRANGER]: 'admin' }, 'Ops', 'OPS'),
});
for (const uid of MEMBERS) {
  put(`boards/${BOARD}/members/${uid}`, { ...fixtures.members, uid, role: ROLES[uid]! });
  put(`boards/${BOARD}/prefs/${uid}`, fixtures.prefs);
}
put(`boards/${BOARD}/views/v_shared`, { ...fixtures.views, scope: 'shared', ownerUid: ADMIN });
put(`boards/${BOARD}/views/v_editor`, { ...fixtures.views, scope: 'personal', ownerUid: EDITOR });
put(`boards/${BOARD}/webhooks/w1`, fixtures.webhooks);
put(`boards/${BOARD}/integrations/github`, fixtures.installs);
put(`boards/${BOARD}/aggStats/daily:2026-09-26`, fixtures.aggStats);
put(T, {
  ...fixtures.tickets,
  assigneeUids: [COMMENTER],
  watcherUids: [ADMIN, COMMENTER],
  createdBy: ADMIN,
});
put(`${T}/data/000`, fixtures.ticketData);
put(`boards/${OTHER_BOARD}/tickets/tkt_ops`, {
  ...fixtures.tickets,
  assigneeUids: [],
  watcherUids: [],
  createdBy: STRANGER,
});

// ─── IceBase's side ──────────────────────────────────────────────────────────

const DOCS = '/databases/(default)/documents';
const asDoc = (path: string, data: Record<string, unknown> | undefined) =>
  data === undefined ? null : { data, id: path.split('/').pop()!, path: `${DOCS}/${path}` };

const interp = (
  uid: string | null,
  method: string,
  path: string,
  after?: Record<string, unknown>,
) =>
  rules.allows({
    method: method as 'get',
    path: `${DOCS}/${path}`,
    auth: uid ? { uid, token: { email: emailOf(uid), email_verified: true } } : null,
    resource: asDoc(path, seed.get(path)),
    requestResource: after === undefined ? null : asDoc(path, after),
    query: null,
    get: (p: string) => asDoc(p.replace(/^\/databases\/[^/]+\/documents\//, ''), seed.get(p.replace(/^\/databases\/[^/]+\/documents\//, ''))),
  });

// ─── the emulator's side ─────────────────────────────────────────────────────

const db = (uid: string | null) => fs(uid ? as(env, uid) : env.unauthenticatedContext());
async function emu(p: Promise<unknown>): Promise<boolean> {
  try {
    await assertSucceeds(p);
    return true;
  } catch {
    try {
      await assertFails(p);
    } catch {
      /* already settled */
    }
    return false;
  }
}

beforeAll(async () => {
  env = await makeEnv({ firestore: true });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = fs(ctx);
    for (const [path, data] of seed) await setDoc(doc(d, path), data);
  });
});
afterAll(() => env?.cleanup());

const WHO = [null, ...EVERYONE, REFUSED];

describe('IceBase rules engine = Firestore emulator', () => {
  it('get: every seeded document, by everyone', async () => {
    const diffs: string[] = [];
    for (const path of seed.keys()) {
      for (const uid of WHO) {
        const want = await emu(getDoc(doc(db(uid), path)));
        const got = await interp(uid, 'get', path);
        if (want !== got)
          diffs.push(`${uid ?? 'anon'} get ${path}: emulator ${want}, interpreter ${got}`);
      }
    }
    expect(diffs).toEqual([]);
  });

  it('get: missing documents (resource null)', async () => {
    const diffs: string[] = [];
    for (const path of [
      `users/${ADMIN}/devices/none`,
      `boards/${BOARD}/members/none`,
      `${T}/data/999`,
      'boards/nope',
    ]) {
      for (const uid of WHO) {
        const want = await emu(getDoc(doc(db(uid), path)));
        const got = await interp(uid, 'get', path);
        if (want !== got)
          diffs.push(`${uid ?? 'anon'} get ${path}: emulator ${want}, interpreter ${got}`);
      }
    }
    expect(diffs).toEqual([]);
  });

  it('writes: devices, inbox flags, read pointers — allowed ones and near misses', async () => {
    const now = Date.now();
    const device = { fcmToken: 'tok', kind: 'web', userAgent: 'ua', lastSeenAt: now };
    const cases: [
      string,
      string,
      'create' | 'update' | 'delete',
      Record<string, unknown> | null,
    ][] = [
      [ADMIN, `users/${ADMIN}/devices/d2`, 'create', device],
      [ADMIN, `users/${ADMIN}/devices/d3`, 'create', { ...device, extra: 1 }],
      [ADMIN, `users/${ADMIN}/devices/d4`, 'create', { ...device, kind: 'fax' }],
      [EDITOR, `users/${ADMIN}/devices/d5`, 'create', device],
      [ADMIN, `users/${ADMIN}/devices/d1`, 'delete', null],
      [ADMIN, `users/${ADMIN}/inbox/n1`, 'update', { readAt: now }],
      [ADMIN, `users/${ADMIN}/inbox/n1`, 'update', { title: 'x' }],
      [ADMIN, `users/${ADMIN}/inbox/n1`, 'update', { readAt: 'soon' }],
      [VIEWER, `users/${ADMIN}/inbox/n1`, 'update', { readAt: now }],
      [ADMIN, `users/${ADMIN}/reads/tkt_new`, 'create', { readAt: now, boardId: BOARD }],
      [
        ADMIN,
        `users/${ADMIN}/reads/tkt_new2`,
        'create',
        { readAt: now, boardId: BOARD, hack: true },
      ],
      [ADMIN, `boards/${BOARD}`, 'update', { name: 'Hacked' }],
      [ADMIN, `${T}`, 'update', { title: 'x' }],
      [REFUSED, `users/${REFUSED}/devices/d1`, 'create', device],
    ];
    const diffs: string[] = [];
    for (const [uid, path, op, data] of cases) {
      const before = seed.get(path);
      const after = op === 'delete' ? undefined : op === 'update' ? { ...before, ...data } : data!;
      const ref = doc(db(uid), path);
      const want = await emu(
        op === 'create'
          ? setDoc(ref, data!)
          : op === 'update'
            ? updateDoc(ref, data!)
            : deleteDoc(ref),
      );
      const method = op === 'create' && before ? 'update' : op;
      const got = await interp(uid, method, path, after);
      if (want !== got)
        diffs.push(
          `${uid} ${op} ${path} ${JSON.stringify(data)}: emulator ${want}, interpreter ${got}`,
        );
      // Keep both sides' databases identical for the next case.
      if (want) {
        if (op === 'delete') seed.delete(path);
        else seed.set(path, after!);
      }
    }
    expect(diffs).toEqual([]);
  });
});

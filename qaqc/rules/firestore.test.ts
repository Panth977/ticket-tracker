/**
 * firestore.rules — allow + deny for every collection in app/db.json and
 * platform/db.json, for a stranger, a viewer, a commenter, an editor, an admin
 * and the owner of a user doc.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { fixtures } from '@tm/shared/schema/fixtures';
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
} from './_env.js';

let env: RulesTestEnvironment;

const TICKET_WATCHED = 'tkt_0002'; // on BOARD, STRANGER is only a watcher (e.g. a removed member)
const TICKET_OPS = 'tkt_ops';
const T = `boards/${BOARD}/tickets/${TICKET}`;

/** Firestore for this uid (null = signed out). */
const db = (uid: string | null, verified = true) =>
  fs(uid ? as(env, uid, verified) : env.unauthenticatedContext());

beforeAll(async () => {
  env = await makeEnv({ firestore: true });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = fs(ctx);
    const put = (path: string, data: object) => setDoc(doc(d, path), data);

    for (const uid of EVERYONE) {
      await put(`users/${uid}`, { ...fixtures.users, email: emailOf(uid) });
    }
    await put(`users/${ADMIN}/devices/d1`, fixtures.devices);
    await put(`users/${ADMIN}/inbox/n1`, fixtures.inbox);
    await put(`users/${ADMIN}/inbox/n2`, { ...fixtures.inbox, archivedAt: 5 });
    await put(`users/${ADMIN}/reads/${TICKET}`, fixtures.reads);
    await put(`users/${ADMIN}/apiKeys/k1`, fixtures.apiKeys);
    await put(`users/${ADMIN}/oauthGrants/g1`, fixtures.oauthGrants);
    await put(`users/${ADMIN}/workspaces/w1`, fixtures.workspaces);
    await put(`users/${ADMIN}/ui/sidebar`, fixtures.sidebarPrefs);

    // STRANGER is invited to BOARD; VIEWER is invited to OTHER_BOARD.
    await put('invites/inv_stranger', {
      ...fixtures.invites,
      boardId: BOARD,
      email: emailOf(STRANGER),
    });
    await put('invites/inv_viewer', {
      ...fixtures.invites,
      boardId: OTHER_BOARD,
      email: emailOf(VIEWER),
    });

    await put('boardKeys/ENG', fixtures.boardKeys);
    await put('keys/ENG-1', fixtures.keys);
    await put('deliveries/dl_viewer', { ...fixtures.deliveries, uid: VIEWER });
    await put('deliveries/dl_admin', { ...fixtures.deliveries, uid: ADMIN });

    // Server-only collections.
    await put('oauthClients/c1', fixtures.oauthClients);
    await put('oauthTokens/t1', { ...fixtures.oauthTokens, uid: ADMIN });
    await put('intakes/eng-bugs', fixtures.intakes);
    await put('emailThreads/r1', { ...fixtures.emailThreads, uid: ADMIN });
    await put('whatsappSessions/+919812345678', { ...fixtures.whatsappSessions, uid: ADMIN });
    await put(`_idem/${ADMIN}_c1`, { at: 0 });
    await put('_jobs/j1', { kind: 'export' });
    await put(`_whatsappOtp/${ADMIN}`, { codeHash: 'x' });
    await put('_dev/mail/items/m1', { to: 'x@y.z' });

    // The board and everything under it.
    await put(`boards/${BOARD}`, { ...fixtures.boards, ...boardDoc(ROLES) });
    await put(`boards/${OTHER_BOARD}`, {
      ...fixtures.boards,
      ...boardDoc({ [STRANGER]: 'admin' }, 'Ops', 'OPS'),
    });
    for (const uid of MEMBERS) {
      await put(`boards/${BOARD}/members/${uid}`, { ...fixtures.members, uid, role: ROLES[uid] });
      await put(`boards/${BOARD}/prefs/${uid}`, fixtures.prefs);
    }
    await put(`boards/${BOARD}/views/v_shared`, {
      ...fixtures.views,
      scope: 'shared',
      ownerUid: ADMIN,
    });
    await put(`boards/${BOARD}/views/v_editor`, {
      ...fixtures.views,
      scope: 'personal',
      ownerUid: EDITOR,
    });
    await put(`boards/${BOARD}/webhooks/w1`, fixtures.webhooks);
    await put(`boards/${BOARD}/webhooks/w1/deliveries/wd1`, fixtures.webhookDeliveries);
    await put(`boards/${BOARD}/integrations/github`, fixtures.installs);

    await put(T, {
      ...fixtures.tickets,
      assigneeUids: [COMMENTER],
      watcherUids: [ADMIN, COMMENTER],
      createdBy: ADMIN,
    });
    // §W: the thread, the activity and the files are FIELDS of the ticket now;
    // what is left under it is the overflow pages.
    await put(`${T}/data/000`, fixtures.ticketData);
    await put(`boards/${BOARD}/tickets/${TICKET_WATCHED}`, {
      ...fixtures.tickets,
      assigneeUids: [],
      watcherUids: [STRANGER],
      createdBy: ADMIN,
    });
    await put(`boards/${OTHER_BOARD}/tickets/${TICKET_OPS}`, {
      ...fixtures.tickets,
      assigneeUids: [STRANGER],
      watcherUids: [STRANGER],
      createdBy: STRANGER,
    });
  });
});

afterAll(async () => {
  await env?.cleanup();
});

// ------------------------------------------------------------------ users

describe('users/{uid}', () => {
  it('any signed-in person may get a profile by uid', async () => {
    for (const uid of EVERYONE) await assertSucceeds(getDoc(doc(db(uid), `users/${ADMIN}`)));
  });
  it('signed-out may not', async () => {
    await assertFails(getDoc(doc(db(null), `users/${ADMIN}`)));
  });
  it('nobody may list people', async () => {
    await assertFails(getDocs(collection(db(ADMIN), 'users')));
    await assertFails(
      getDocs(query(collection(db(ADMIN), 'users'), where('email', '==', emailOf(ADMIN)))),
    );
  });
  it('not even the owner may write their profile (profileUpdate)', async () => {
    await assertFails(updateDoc(doc(db(ADMIN), `users/${ADMIN}`), { name: 'X' }));
    await assertFails(setDoc(doc(db(STRANGER), `users/u_new`), fixtures.users));
    await assertFails(deleteDoc(doc(db(ADMIN), `users/${ADMIN}`)));
  });
});

describe('users/{uid}/devices', () => {
  const p = `users/${ADMIN}/devices`;
  it('owner registers, refreshes, reads and removes a device', async () => {
    const mine = db(ADMIN);
    await assertSucceeds(setDoc(doc(mine, `${p}/d2`), fixtures.devices));
    await assertSucceeds(setDoc(doc(mine, `${p}/d2`), { ...fixtures.devices, lastSeenAt: 99 }));
    await assertSucceeds(getDoc(doc(mine, `${p}/d2`)));
    await assertSucceeds(getDocs(collection(mine, p)));
    await assertSucceeds(deleteDoc(doc(mine, `${p}/d2`)));
  });
  it('owner may not write an invalid device', async () => {
    const mine = db(ADMIN);
    await assertFails(setDoc(doc(mine, `${p}/d3`), { ...fixtures.devices, kind: 'fridge' }));
    await assertFails(setDoc(doc(mine, `${p}/d3`), { ...fixtures.devices, extra: 1 }));
    await assertFails(setDoc(doc(mine, `${p}/d3`), { kind: 'web', userAgent: 'x', lastSeenAt: 1 }));
    await assertFails(setDoc(doc(mine, `${p}/d3`), { ...fixtures.devices, fcmToken: '' }));
  });
  it('nobody else may read or write it', async () => {
    for (const uid of [EDITOR, STRANGER]) {
      await assertFails(getDoc(doc(db(uid), `${p}/d1`)));
      await assertFails(setDoc(doc(db(uid), `${p}/d9`), fixtures.devices));
      await assertFails(deleteDoc(doc(db(uid), `${p}/d1`)));
    }
    await assertFails(getDoc(doc(db(null), `${p}/d1`)));
  });
});

describe('users/{uid}/inbox', () => {
  const p = `users/${ADMIN}/inbox`;
  it('owner reads the bell query', async () => {
    const q = query(
      collection(db(ADMIN), p),
      where('archivedAt', '==', null),
      orderBy('createdAt', 'desc'),
    );
    await assertSucceeds(getDocs(q));
    await assertSucceeds(getDoc(doc(db(ADMIN), `${p}/n1`)));
  });
  it('owner may flip readAt / archivedAt / snoozedUntil', async () => {
    await assertSucceeds(updateDoc(doc(db(ADMIN), `${p}/n1`), { readAt: 10 }));
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), `${p}/n1`), { archivedAt: 11, snoozedUntil: 12 }),
    );
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), `${p}/n1`), { archivedAt: null, snoozedUntil: null }),
    );
  });
  it('owner may not change anything else, create, or delete', async () => {
    await assertFails(updateDoc(doc(db(ADMIN), `${p}/n1`), { summary: 'forged' }));
    await assertFails(updateDoc(doc(db(ADMIN), `${p}/n1`), { readAt: 10, count: 99 }));
    await assertFails(updateDoc(doc(db(ADMIN), `${p}/n1`), { readAt: 'yesterday' }));
    await assertFails(setDoc(doc(db(ADMIN), `${p}/n9`), fixtures.inbox));
    await assertFails(deleteDoc(doc(db(ADMIN), `${p}/n1`)));
  });
  it('nobody else may read or touch it', async () => {
    await assertFails(getDoc(doc(db(EDITOR), `${p}/n1`)));
    await assertFails(getDocs(collection(db(STRANGER), p)));
    await assertFails(updateDoc(doc(db(EDITOR), `${p}/n1`), { readAt: 1 }));
  });
});

describe('users/{uid}/reads', () => {
  const p = `users/${ADMIN}/reads`;
  it('owner writes and reads their read pointers', async () => {
    await assertSucceeds(setDoc(doc(db(ADMIN), `${p}/tkt_9`), { boardId: BOARD, readAt: 5 }));
    await assertSucceeds(updateDoc(doc(db(ADMIN), `${p}/tkt_9`), { readAt: 6 }));
    await assertSucceeds(getDoc(doc(db(ADMIN), `${p}/${TICKET}`)));
    await assertSucceeds(getDocs(collection(db(ADMIN), p)));
  });
  it('owner may only write { boardId, readAt, ticketId } — ticketId must be the doc id', async () => {
    await assertSucceeds(
      setDoc(doc(db(ADMIN), `${p}/tkt_6`), { boardId: BOARD, readAt: 5, ticketId: 'tkt_6' }),
    );
    await assertFails(
      setDoc(doc(db(ADMIN), `${p}/tkt_5`), { boardId: BOARD, readAt: 5, ticketId: 'tkt_other' }),
    );
    await assertFails(setDoc(doc(db(ADMIN), `${p}/tkt_8`), { boardId: BOARD, readAt: 5, x: 1 }));
    await assertFails(setDoc(doc(db(ADMIN), `${p}/tkt_8`), { boardId: BOARD, readAt: 'now' }));
    await assertFails(updateDoc(doc(db(ADMIN), `${p}/${TICKET}`), { other: true }));
  });
  it('nobody else may write them; only people on that board may read them (Seen by)', async () => {
    await assertFails(setDoc(doc(db(STRANGER), `${p}/tkt_7`), { boardId: BOARD, readAt: 5 }));
    await assertFails(setDoc(doc(db(EDITOR), `${p}/tkt_7`), { boardId: BOARD, readAt: 5 }));
    await assertSucceeds(getDoc(doc(db(EDITOR), `${p}/${TICKET}`)));
    await assertFails(getDoc(doc(db(STRANGER), `${p}/${TICKET}`)));
  });
  it("the thread's 'Seen by' query: board + ticket, by collection group", async () => {
    const seen = (uid: string, board: string) =>
      getDocs(
        query(
          collectionGroup(db(uid), 'reads'),
          where('boardId', '==', board),
          where('ticketId', '==', 'tkt_6'),
        ),
      );
    for (const uid of MEMBERS) await assertSucceeds(seen(uid, BOARD));
    await assertFails(seen(STRANGER, BOARD));
    // unfiltered: refused (rules cannot prove every row is on a readable board)
    await assertFails(getDocs(collectionGroup(db(EDITOR), 'reads')));
  });
});

describe('users/{uid}/apiKeys, oauthGrants, workspaces and ui (§AB)', () => {
  for (const sub of ['apiKeys/k1', 'oauthGrants/g1', 'workspaces/w1', 'ui/sidebar']) {
    it(`${sub}: owner reads, nobody writes`, async () => {
      const path = `users/${ADMIN}/${sub}`;
      await assertSucceeds(getDoc(doc(db(ADMIN), path)));
      await assertFails(getDoc(doc(db(EDITOR), path)));
      await assertFails(getDoc(doc(db(STRANGER), path)));
      await assertFails(deleteDoc(doc(db(ADMIN), path)));
      await assertFails(updateDoc(doc(db(ADMIN), path), { name: 'x' }));
      await assertFails(setDoc(doc(db(ADMIN), `${path}-new`), { name: 'x' }));
    });
  }
  it('workspaces: the owner lists their own, nobody lists anyone else\'s', async () => {
    await assertSucceeds(getDocs(collection(db(ADMIN), `users/${ADMIN}/workspaces`)));
    await assertFails(getDocs(collection(db(EDITOR), `users/${ADMIN}/workspaces`)));
  });
});

// ------------------------------------------------------------------ top level

describe('invites', () => {
  it('the invitee (verified email) gets and lists their invites', async () => {
    await assertSucceeds(getDoc(doc(db(STRANGER), 'invites/inv_stranger')));
    await assertSucceeds(
      getDocs(query(collection(db(STRANGER), 'invites'), where('email', '==', emailOf(STRANGER)))),
    );
    await assertSucceeds(getDoc(doc(db(VIEWER), 'invites/inv_viewer')));
  });
  it('an unverified email is not enough', async () => {
    await assertFails(getDoc(doc(db(STRANGER, false), 'invites/inv_stranger')));
  });
  it("a board admin sees that board's invites", async () => {
    await assertSucceeds(getDoc(doc(db(ADMIN), 'invites/inv_stranger')));
    await assertSucceeds(
      getDocs(query(collection(db(ADMIN), 'invites'), where('boardId', '==', BOARD))),
    );
  });
  it('editors, commenters, viewers and others see nothing else', async () => {
    for (const uid of [EDITOR, COMMENTER, VIEWER]) {
      await assertFails(getDoc(doc(db(uid), 'invites/inv_stranger')));
      await assertFails(
        getDocs(query(collection(db(uid), 'invites'), where('boardId', '==', BOARD))),
      );
    }
    await assertFails(getDoc(doc(db(ADMIN), 'invites/inv_viewer'))); // another board's
    await assertFails(getDocs(collection(db(STRANGER), 'invites')));
    await assertFails(
      getDocs(query(collection(db(STRANGER), 'invites'), where('email', '==', emailOf(VIEWER)))),
    );
    await assertFails(getDoc(doc(db(null), 'invites/inv_stranger')));
  });
  it('nobody writes invites', async () => {
    await assertFails(
      setDoc(doc(db(ADMIN), 'invites/new'), { ...fixtures.invites, boardId: BOARD }),
    );
    await assertFails(updateDoc(doc(db(STRANGER), 'invites/inv_stranger'), { status: 'accepted' }));
    await assertFails(deleteDoc(doc(db(ADMIN), 'invites/inv_stranger')));
  });
});

describe('boardKeys and keys', () => {
  for (const path of ['boardKeys/ENG', 'keys/ENG-1']) {
    const coll = path.split('/')[0]!;
    it(`${coll}: any signed-in person may get one, not list, not write`, async () => {
      await assertSucceeds(getDoc(doc(db(STRANGER), path)));
      await assertSucceeds(getDoc(doc(db(STRANGER), `${coll}/NOPE`)));
      await assertFails(getDoc(doc(db(null), path)));
      await assertFails(getDocs(collection(db(ADMIN), coll)));
      await assertFails(setDoc(doc(db(ADMIN), `${coll}/NEW`), { boardId: BOARD }));
      await assertFails(deleteDoc(doc(db(ADMIN), path)));
    });
  }
});

describe('deliveries (notification log)', () => {
  it('the person it was for reads it', async () => {
    await assertSucceeds(getDoc(doc(db(VIEWER), 'deliveries/dl_viewer')));
    await assertSucceeds(
      getDocs(
        query(
          collection(db(VIEWER), 'deliveries'),
          where('uid', '==', VIEWER),
          orderBy('createdAt', 'desc'),
        ),
      ),
    );
  });
  it('nobody else, and nobody writes', async () => {
    await assertFails(getDoc(doc(db(ADMIN), 'deliveries/dl_viewer')));
    await assertFails(getDocs(collection(db(VIEWER), 'deliveries')));
    await assertFails(
      setDoc(doc(db(VIEWER), 'deliveries/x'), { ...fixtures.deliveries, uid: VIEWER }),
    );
  });
});

describe('server-only collections', () => {
  const paths = [
    'oauthClients/c1',
    'oauthTokens/t1',
    'intakes/eng-bugs',
    'emailThreads/r1',
    'whatsappSessions/+919812345678',
    `_idem/${ADMIN}_c1`,
    '_jobs/j1', // long-running job params (accountExport)
    `_whatsappOtp/${ADMIN}`, // WhatsApp verification codes (notify)
    '_dev/mail/items/m1', // the dev outbox
  ];
  for (const path of paths) {
    it(`${path.split('/')[0]}: no client reads or writes`, async () => {
      await assertFails(getDoc(doc(db(ADMIN), path)));
      await assertFails(setDoc(doc(db(ADMIN), path), { x: 1 }));
      await assertFails(getDocs(collection(db(ADMIN), path.split('/')[0]!)));
    });
  }
});

// ------------------------------------------------------------------ boards

describe('boards', () => {
  it('every role may get the board; a stranger may not', async () => {
    for (const uid of MEMBERS) await assertSucceeds(getDoc(doc(db(uid), `boards/${BOARD}`)));
    await assertFails(getDoc(doc(db(STRANGER), `boards/${BOARD}`)));
    await assertFails(getDoc(doc(db(null), `boards/${BOARD}`)));
  });
  it('the sidebar query (readerUids array-contains me) is allowed', async () => {
    for (const uid of EVERYONE) {
      await assertSucceeds(
        getDocs(query(collection(db(uid), 'boards'), where('readerUids', 'array-contains', uid))),
      );
    }
  });
  it('any other list of boards is not — there is no directory', async () => {
    await assertFails(getDocs(collection(db(ADMIN), 'boards')));
    await assertFails(
      getDocs(
        query(collection(db(STRANGER), 'boards'), where('readerUids', 'array-contains', ADMIN)),
      ),
    );
    await assertFails(
      getDocs(query(collection(db(STRANGER), 'boards'), where('key', '==', 'ENG'))),
    );
  });
  it('not even an admin writes a board directly', async () => {
    await assertFails(updateDoc(doc(db(ADMIN), `boards/${BOARD}`), { name: 'x' }));
    await assertFails(
      updateDoc(doc(db(STRANGER), `boards/${BOARD}`), { [`access.${STRANGER}`]: 'admin' }),
    );
    await assertFails(setDoc(doc(db(STRANGER), 'boards/b_new'), boardDoc({ [STRANGER]: 'admin' })));
    await assertFails(deleteDoc(doc(db(ADMIN), `boards/${BOARD}`)));
  });
});

/** Board-scoped collections every role may read and nobody may write. */
const boardScoped: { name: string; doc: string; coll: string }[] = [
  { name: 'members', doc: `boards/${BOARD}/members/${VIEWER}`, coll: `boards/${BOARD}/members` },
  {
    name: 'integrations',
    doc: `boards/${BOARD}/integrations/github`,
    coll: `boards/${BOARD}/integrations`,
  },
  { name: 'tickets', doc: T, coll: `boards/${BOARD}/tickets` },
  // §W: boards/{b}/tickets/{t}/data/{NNN} — the spilled older messages.
  { name: 'ticket data pages', doc: `${T}/data/000`, coll: `${T}/data` },
];

for (const c of boardScoped) {
  describe(c.name, () => {
    it('every role on the board may read', async () => {
      for (const uid of MEMBERS) {
        await assertSucceeds(getDoc(doc(db(uid), c.doc)));
        await assertSucceeds(getDocs(collection(db(uid), c.coll)));
      }
    });
    it('a stranger (admin of another board) and signed-out may not', async () => {
      await assertFails(getDoc(doc(db(STRANGER), c.doc)));
      await assertFails(getDocs(collection(db(STRANGER), c.coll)));
      await assertFails(getDoc(doc(db(null), c.doc)));
    });
    it('nobody writes — the command layer does', async () => {
      for (const uid of [ADMIN, EDITOR]) {
        await assertFails(setDoc(doc(db(uid), `${c.coll}/new_${uid}`), { x: 1 }));
        await assertFails(updateDoc(doc(db(uid), c.doc), { x: 1 }));
        await assertFails(deleteDoc(doc(db(uid), c.doc)));
      }
    });
  });
}

describe('the thread lives on the ticket (§W)', () => {
  it('the old subcollections are readable by nobody, because nothing is there', async () => {
    for (const sub of ['messages', 'activity', 'files', 'tasklists']) {
      await assertFails(getDocs(collection(db(COMMENTER), `${T}/${sub}`)));
      await assertFails(setDoc(doc(db(ADMIN), `${T}/${sub}/x`), { x: 1 }));
    }
  });
  it('a stranger cannot read a ticket\u2019s data pages', async () => {
    await assertFails(getDocs(collection(db(STRANGER), `${T}/data`)));
  });
});

describe('prefs', () => {
  it('only the person themself reads their prefs', async () => {
    for (const uid of MEMBERS)
      await assertSucceeds(getDoc(doc(db(uid), `boards/${BOARD}/prefs/${uid}`)));
    await assertFails(getDoc(doc(db(ADMIN), `boards/${BOARD}/prefs/${VIEWER}`)));
    await assertFails(getDocs(collection(db(ADMIN), `boards/${BOARD}/prefs`)));
  });
  it('nobody writes prefs directly (boardPrefSet)', async () => {
    await assertFails(
      updateDoc(doc(db(VIEWER), `boards/${BOARD}/prefs/${VIEWER}`), { starred: false }),
    );
  });
});

describe('views', () => {
  const v = `boards/${BOARD}/views`;
  it('shared views: every role', async () => {
    for (const uid of MEMBERS) {
      await assertSucceeds(getDoc(doc(db(uid), `${v}/v_shared`)));
      await assertSucceeds(getDocs(query(collection(db(uid), v), where('scope', '==', 'shared'))));
    }
  });
  it('personal views: their owner only', async () => {
    await assertSucceeds(getDoc(doc(db(EDITOR), `${v}/v_editor`)));
    await assertSucceeds(
      getDocs(query(collection(db(EDITOR), v), where('ownerUid', '==', EDITOR))),
    );
    await assertFails(getDoc(doc(db(ADMIN), `${v}/v_editor`)));
    await assertFails(getDocs(query(collection(db(ADMIN), v), where('ownerUid', '==', EDITOR))));
    await assertFails(getDocs(collection(db(VIEWER), v))); // would include someone's personal view
  });
  it('strangers see none; nobody writes', async () => {
    await assertFails(getDoc(doc(db(STRANGER), `${v}/v_shared`)));
    await assertFails(
      setDoc(doc(db(EDITOR), `${v}/v_new`), { ...fixtures.views, ownerUid: EDITOR }),
    );
    await assertFails(updateDoc(doc(db(EDITOR), `${v}/v_editor`), { name: 'x' }));
  });
});

describe('webhooks and their deliveries', () => {
  for (const path of [
    `boards/${BOARD}/webhooks/w1`,
    `boards/${BOARD}/webhooks/w1/deliveries/wd1`,
  ]) {
    it(`${path.split('/').at(-2)}: board admin only`, async () => {
      await assertSucceeds(getDoc(doc(db(ADMIN), path)));
      for (const uid of [EDITOR, COMMENTER, VIEWER, STRANGER])
        await assertFails(getDoc(doc(db(uid), path)));
      await assertFails(updateDoc(doc(db(ADMIN), path), { x: 1 }));
    });
  }
  it('admin lists them', async () => {
    await assertSucceeds(getDocs(collection(db(ADMIN), `boards/${BOARD}/webhooks`)));
    await assertFails(getDocs(collection(db(EDITOR), `boards/${BOARD}/webhooks`)));
  });
});

// --------------------------------------------------------- tickets collection group

describe('tickets collection group (My Work)', () => {
  it('assignee query is provable from the query alone', async () => {
    const q = (uid: string, who: string) =>
      query(collectionGroup(db(uid), 'tickets'), where('assigneeUids', 'array-contains', who));
    await assertSucceeds(getDocs(q(COMMENTER, COMMENTER)));
    await assertSucceeds(getDocs(q(STRANGER, STRANGER)));
    await assertFails(getDocs(q(COMMENTER, ADMIN)));
  });
  it('watcher and createdBy queries too', async () => {
    await assertSucceeds(
      getDocs(
        query(
          collectionGroup(db(STRANGER), 'tickets'),
          where('watcherUids', 'array-contains', STRANGER),
        ),
      ),
    );
    await assertSucceeds(
      getDocs(query(collectionGroup(db(ADMIN), 'tickets'), where('createdBy', '==', ADMIN))),
    );
  });
  it('an unconstrained collection-group query is refused', async () => {
    await assertFails(getDocs(collectionGroup(db(ADMIN), 'tickets')));
    await assertFails(getDocs(collectionGroup(db(null), 'tickets')));
  });
  it('a watcher off the board may get that one ticket, not its siblings', async () => {
    await assertSucceeds(getDoc(doc(db(STRANGER), `boards/${BOARD}/tickets/${TICKET_WATCHED}`)));
    await assertFails(getDoc(doc(db(STRANGER), T)));
    await assertFails(getDoc(doc(db(STRANGER), `${T}/data/000`)));
  });
  it('members of one board cannot read another board’s tickets by path', async () => {
    await assertFails(getDoc(doc(db(ADMIN), `boards/${OTHER_BOARD}/tickets/${TICKET_OPS}`)));
  });
});

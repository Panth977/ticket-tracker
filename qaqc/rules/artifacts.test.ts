/**
 * ARTIFACTS (docs/plan/artifacts.html §B, §E4) — the three rule files, for
 * every role against every prefix an artifact owns:
 *
 *   Firestore  artifacts/{a}, its builds, db/data/** (the artifact's own
 *              documents), viewers/{uid}/kv/*
 *   RTDB       artifactData/{a}/** behind the artifactReaders / artifactFlags
 *              mirrors (both server-only)
 *   Storage    artifacts/{a}/files/**, uploads/*.zip, builds/**, source/**
 *
 * THE RULES ARE THE FENCE: the broker that talks to Firebase for an artifact
 * runs in the viewer's browser, so every promise the driver makes is proven
 * here against the rules themselves.
 *
 * THE CAST (the people of _env.ts, in other clothes):
 *   ADMIN      owner of ART, RO and ARCH
 *   EDITOR     editor of all three
 *   VIEWER     viewer of all three
 *   COMMENTER  on a BOARD with all of them, on no artifact — being on a board
 *              gives nothing here
 *   STRANGER   owner of OTHER — so "has a role somewhere" is never mistaken
 *              for "has a role here"
 *   REFUSED    a viewer of ART whom the admin took off the allow list
 *
 *   ART    an ordinary artifact           (viewers write)
 *   RO     read-only for viewers
 *   ARCH   archived                       (nobody writes data)
 *   OTHER  somebody else's
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
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { get, ref as rref, remove, set, update } from 'firebase/database';
import {
  deleteObject,
  getBytes,
  getMetadata,
  listAll,
  ref as sref,
  uploadBytes,
} from 'firebase/storage';
import {
  ARTIFACT_INVITE_BOARD_ID,
  ARTIFACT_INVITE_BOARD_KEY,
  ARTIFACT_UPLOAD_MAX_BYTES,
  artifactFirestoreDoc,
  artifactKvDoc,
  artifactPrefix,
  artifactRtdbPath,
  artifactStorageFile,
} from '@tm/shared';
import { fixtures } from '@tm/shared/schema/fixtures';
import {
  ADMIN,
  BOARD,
  COMMENTER,
  EDITOR,
  ROLES,
  STRANGER,
  VIEWER,
  as,
  boardDoc,
  emailOf,
  fs,
  makeEnv,
  rt,
  st,
} from './_env.js';

const OWNER = ADMIN;
const REFUSED = 'u_refused';

const ART = 'art_alpha01';
const RO = 'art_ronly01';
const ARCH = 'art_archv01';
const OTHER = 'art_other01';
const MINE = [ART, RO, ARCH];

type Role = 'owner' | 'editor' | 'viewer';
const CAST: Record<string, Role> = { [OWNER]: 'owner', [EDITOR]: 'editor', [VIEWER]: 'viewer' };
const WITH_ROLE = Object.keys(CAST);
/** People with no role on ART / RO / ARCH. null = signed out. */
const OUTSIDERS: (string | null)[] = [STRANGER, COMMENTER, null];

function artifactDoc(access: Record<string, Role>, over: Record<string, unknown> = {}) {
  return {
    ...fixtures.artifacts,
    ownerUid: Object.keys(access).find((u) => access[u] === 'owner'),
    access,
    memberUids: Object.keys(access).sort(),
    agents: {},
    readOnly: false,
    archivedAt: null,
    ...over,
  };
}

const zip = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let env: RulesTestEnvironment;

const ctxOf = (uid: string | null) => (uid ? as(env, uid) : env.unauthenticatedContext());
const db = (uid: string | null) => fs(ctxOf(uid));
const rtdbOf = (uid: string | null) => rt(ctxOf(uid));
const storageOf = (uid: string | null) => st(ctxOf(uid));

beforeAll(async () => {
  env = await makeEnv({ firestore: true, storage: true, database: true });
  await env.clearFirestore();
  await env.clearStorage();
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = fs(ctx);
    const put = (path: string, data: object) => setDoc(doc(d, path), data);

    for (const uid of [...WITH_ROLE, STRANGER, COMMENTER])
      await put(`users/${uid}`, { ...fixtures.users, email: emailOf(uid) });
    // §X: a role in `access` does not outlive the allow list.
    await put(`users/${REFUSED}`, { ...fixtures.users, email: emailOf(REFUSED), allowed: false });
    // Everyone shares a board — which must count for nothing on an artifact.
    await put(`boards/${BOARD}`, boardDoc({ ...ROLES, [STRANGER]: 'editor' }));

    await put(`artifacts/${ART}`, artifactDoc({ ...CAST, [REFUSED]: 'viewer' }));
    await put(`artifacts/${RO}`, artifactDoc(CAST, { readOnly: true }));
    await put(`artifacts/${ARCH}`, artifactDoc(CAST, { archivedAt: 5 }));
    await put(`artifacts/${OTHER}`, artifactDoc({ [STRANGER]: 'owner' }));

    for (const a of [...MINE, OTHER]) {
      await put(`artifacts/${a}/builds/build_0000000001`, fixtures.artifactBuilds);
      await put(artifactFirestoreDoc(a, '/my/doc'), { n: 1 });
      await put(artifactFirestoreDoc(a, '/my/doc/items/one'), { n: 2 });
      const s = st(ctx);
      await uploadBytes(sref(s, artifactStorageFile(a, '/pics/cat.png')), png);
      await uploadBytes(sref(s, `${artifactPrefix.storageBuild(a, 'b1')}/index.html`), png);
      await uploadBytes(sref(s, artifactPrefix.storageSource(a, 'b1')), zip);
      await uploadBytes(sref(s, artifactPrefix.storageUpload(a, 'taken')), zip);
    }
    await put(artifactKvDoc(ART, VIEWER, 'theme'), { value: 'dark', updatedAt: 1 });
    await put(artifactKvDoc(ART, EDITOR, 'theme'), { value: 'light', updatedAt: 1 });
    await put(artifactKvDoc(OTHER, STRANGER, 'theme'), { value: 'dark', updatedAt: 1 });

    // An artifact invite (no account yet for the address) and a board invite.
    await put('invites/inv_art', {
      ...fixtures.invites,
      boardId: ARTIFACT_INVITE_BOARD_ID,
      boardKey: ARTIFACT_INVITE_BOARD_KEY,
      boardName: 'Sales dashboard',
      email: emailOf(COMMENTER),
      role: 'viewer',
      invitedBy: OWNER,
      artifactId: ART,
    });
    await put('invites/inv_board', { ...fixtures.invites, boardId: BOARD, email: 'x@example.com' });

    // The RTDB mirrors, as syncArtifactMirror writes them.
    const r = rt(ctx);
    for (const a of MINE) await set(rref(r, artifactPrefix.rtdbReaders(a)), CAST);
    await set(rref(r, artifactPrefix.rtdbReaders(OTHER)), { [STRANGER]: 'owner' });
    await set(rref(r, artifactPrefix.rtdbFlags(ART)), { readOnly: false, archived: false });
    await set(rref(r, artifactPrefix.rtdbFlags(RO)), { readOnly: true, archived: false });
    await set(rref(r, artifactPrefix.rtdbFlags(ARCH)), { readOnly: false, archived: true });
    await set(rref(r, artifactPrefix.rtdbFlags(OTHER)), { readOnly: false, archived: false });
    // Readers without flags (a mirror write that half-failed): viewers fail closed.
    await set(rref(r, artifactPrefix.rtdbReaders('art_noflag1')), CAST);
    for (const a of [...MINE, OTHER, 'art_noflag1'])
      await set(rref(r, artifactRtdbPath(a, '/counter')), 1);
  });
});

afterAll(async () => {
  await env?.cleanup();
});

// ═════════════════════════════════ Firestore ═════════════════════════════════

describe('firestore · the artifact document and its builds', () => {
  it('every role reads the document; nobody else does', async () => {
    for (const a of MINE)
      for (const uid of WITH_ROLE) await assertSucceeds(getDoc(doc(db(uid), `artifacts/${a}`)));
    for (const uid of OUTSIDERS) await assertFails(getDoc(doc(db(uid), `artifacts/${ART}`)));
  });

  it('"my artifacts" is where(memberUids array-contains me) — and nothing looser', async () => {
    for (const uid of WITH_ROLE)
      await assertSucceeds(
        getDocs(
          query(collection(db(uid), 'artifacts'), where('memberUids', 'array-contains', uid)),
        ),
      );
    // No directory of artifacts, and no asking for somebody else's list.
    await assertFails(getDocs(collection(db(OWNER), 'artifacts')));
    await assertFails(
      getDocs(
        query(collection(db(VIEWER), 'artifacts'), where('memberUids', 'array-contains', OWNER)),
      ),
    );
    await assertFails(
      getDocs(query(collection(db(null), 'artifacts'), where('memberUids', 'array-contains', 'x'))),
    );
  });

  it('no client writes the document — not even its owner', async () => {
    const d = doc(db(OWNER), `artifacts/${ART}`);
    await assertFails(updateDoc(d, { name: 'Renamed' }));
    await assertFails(updateDoc(d, { [`access.${STRANGER}`]: 'owner' }));
    await assertFails(updateDoc(d, { readOnly: true }));
    await assertFails(deleteDoc(d));
    await assertFails(
      setDoc(doc(db(OWNER), 'artifacts/art_new0001'), artifactDoc({ [OWNER]: 'owner' })),
    );
    // A viewer cannot promote themselves.
    await assertFails(
      updateDoc(doc(db(VIEWER), `artifacts/${ART}`), { [`access.${VIEWER}`]: 'owner' }),
    );
  });

  it('builds: every role reads and lists; nobody writes', async () => {
    for (const uid of WITH_ROLE) {
      await assertSucceeds(getDoc(doc(db(uid), `artifacts/${ART}/builds/build_0000000001`)));
      await assertSucceeds(getDocs(collection(db(uid), `artifacts/${ART}/builds`)));
    }
    for (const uid of OUTSIDERS)
      await assertFails(getDoc(doc(db(uid), `artifacts/${ART}/builds/build_0000000001`)));
    await assertFails(
      setDoc(doc(db(OWNER), `artifacts/${ART}/builds/forged`), fixtures.artifactBuilds),
    );
    await assertFails(deleteDoc(doc(db(OWNER), `artifacts/${ART}/builds/build_0000000001`)));
  });

  it('a role in access does not outlive the allow list', async () => {
    await assertFails(getDoc(doc(db(REFUSED), `artifacts/${ART}`)));
    await assertFails(getDoc(doc(db(REFUSED), artifactFirestoreDoc(ART, '/my/doc'))));
    await assertFails(setDoc(doc(db(REFUSED), artifactFirestoreDoc(ART, '/my/x')), { n: 1 }));
  });
});

describe('firestore · db/data — the artifact’s own documents', () => {
  const SHALLOW = '/my/doc';
  const DEEP = '/my/doc/items/one';

  it('every role reads documents and lists collections, at any depth', async () => {
    for (const a of MINE)
      for (const uid of WITH_ROLE) {
        await assertSucceeds(getDoc(doc(db(uid), artifactFirestoreDoc(a, SHALLOW))));
        await assertSucceeds(getDoc(doc(db(uid), artifactFirestoreDoc(a, DEEP))));
        await assertSucceeds(
          getDocs(collection(db(uid), `${artifactPrefix.firestore(a)}/my/doc/items`)),
        );
      }
  });

  it('nobody without a role reads anything', async () => {
    for (const uid of OUTSIDERS) {
      await assertFails(getDoc(doc(db(uid), artifactFirestoreDoc(ART, SHALLOW))));
      await assertFails(getDoc(doc(db(uid), artifactFirestoreDoc(ART, DEEP))));
      await assertFails(getDocs(collection(db(uid), `${artifactPrefix.firestore(ART)}/my`)));
    }
  });

  it('ART: owner, editor AND viewer write (viewers write by default, §B)', async () => {
    for (const uid of WITH_ROLE) {
      await assertSucceeds(
        setDoc(doc(db(uid), artifactFirestoreDoc(ART, `/w/${uid}`)), { by: uid }),
      );
      await assertSucceeds(
        updateDoc(doc(db(uid), artifactFirestoreDoc(ART, `/w/${uid}`)), { n: 2 }),
      );
      await assertSucceeds(
        setDoc(doc(db(uid), artifactFirestoreDoc(ART, `/w/${uid}/deep/er`)), { by: uid }),
      );
      await assertSucceeds(deleteDoc(doc(db(uid), artifactFirestoreDoc(ART, `/w/${uid}/deep/er`))));
    }
  });

  it('RO: a read-only viewer reads but cannot write; owner and editor still can', async () => {
    await assertSucceeds(getDoc(doc(db(VIEWER), artifactFirestoreDoc(RO, SHALLOW))));
    await assertFails(setDoc(doc(db(VIEWER), artifactFirestoreDoc(RO, '/w/v')), { n: 1 }));
    await assertFails(updateDoc(doc(db(VIEWER), artifactFirestoreDoc(RO, SHALLOW)), { n: 9 }));
    await assertFails(deleteDoc(doc(db(VIEWER), artifactFirestoreDoc(RO, SHALLOW))));
    for (const uid of [OWNER, EDITOR])
      await assertSucceeds(setDoc(doc(db(uid), artifactFirestoreDoc(RO, `/w/${uid}`)), { n: 1 }));
  });

  it('ARCH: archived means nobody writes — the owner included — and everyone still reads', async () => {
    for (const uid of WITH_ROLE) {
      await assertSucceeds(getDoc(doc(db(uid), artifactFirestoreDoc(ARCH, SHALLOW))));
      await assertFails(setDoc(doc(db(uid), artifactFirestoreDoc(ARCH, `/w/${uid}`)), { n: 1 }));
      await assertFails(updateDoc(doc(db(uid), artifactFirestoreDoc(ARCH, SHALLOW)), { n: 9 }));
      await assertFails(deleteDoc(doc(db(uid), artifactFirestoreDoc(ARCH, SHALLOW))));
    }
  });

  it('nobody without a role writes', async () => {
    for (const uid of OUTSIDERS)
      await assertFails(setDoc(doc(db(uid), artifactFirestoreDoc(ART, '/w/intruder')), { n: 1 }));
  });

  it('an artifact that does not exist has no data to read or write', async () => {
    await assertFails(getDoc(doc(db(OWNER), artifactFirestoreDoc('art_nope0001', SHALLOW))));
    await assertFails(
      setDoc(doc(db(OWNER), artifactFirestoreDoc('art_nope0001', '/w/x')), { n: 1 }),
    );
  });

  it('the two collection names the collection-group rules would leak are refused', async () => {
    // `/{path=**}/tickets/*` and `/{path=**}/reads/*` grant reads by what the
    // DOCUMENT says, to people the artifact was never shared with. RAW paths on
    // purpose: the shared fence (artifactFirestoreDoc) refuses these names
    // itself now, and this is the test that the RULE does too.
    await assertFails(
      setDoc(doc(db(OWNER), `${artifactPrefix.firestore(ART)}/tickets/t1`), {
        assigneeUids: [STRANGER],
        watcherUids: [],
        createdBy: STRANGER,
      }),
    );
    await assertFails(
      setDoc(doc(db(OWNER), `${artifactPrefix.firestore(ART)}/a/b/reads/r1`), { boardId: BOARD }),
    );
    // Names that merely contain them are fine.
    await assertSucceeds(
      setDoc(doc(db(OWNER), artifactFirestoreDoc(ART, '/my-tickets/t1')), { n: 1 }),
    );
    await assertSucceeds(
      setDoc(doc(db(OWNER), artifactFirestoreDoc(ART, '/tickets-2/t1')), { n: 1 }),
    );
  });
});

describe('firestore · kv — per viewer, per artifact', () => {
  it('a person reads, writes and deletes their own keys', async () => {
    for (const uid of WITH_ROLE) {
      const d = doc(db(uid), artifactKvDoc(ART, uid, 'k'));
      await assertSucceeds(setDoc(d, { value: 1, updatedAt: 1 }));
      await assertSucceeds(getDoc(d));
      await assertSucceeds(getDocs(collection(db(uid), artifactPrefix.kv(ART, uid))));
      await assertSucceeds(deleteDoc(d));
    }
  });

  it('even a read-only viewer writes their own kv (it replaces the localStorage the sandbox took)', async () => {
    await assertSucceeds(
      setDoc(doc(db(VIEWER), artifactKvDoc(RO, VIEWER, 'k')), { value: 1, updatedAt: 1 }),
    );
  });

  it('two viewers never see each other’s keys — nor does the owner', async () => {
    await assertFails(getDoc(doc(db(EDITOR), artifactKvDoc(ART, VIEWER, 'theme'))));
    await assertFails(getDoc(doc(db(VIEWER), artifactKvDoc(ART, EDITOR, 'theme'))));
    await assertFails(getDoc(doc(db(OWNER), artifactKvDoc(ART, VIEWER, 'theme'))));
    await assertFails(getDocs(collection(db(OWNER), artifactPrefix.kv(ART, VIEWER))));
    await assertFails(
      setDoc(doc(db(EDITOR), artifactKvDoc(ART, VIEWER, 'theme')), { value: 'x', updatedAt: 2 }),
    );
    await assertFails(deleteDoc(doc(db(OWNER), artifactKvDoc(ART, VIEWER, 'theme'))));
  });

  it('no role, no kv — even under your own uid', async () => {
    await assertFails(
      setDoc(doc(db(STRANGER), artifactKvDoc(ART, STRANGER, 'k')), { value: 1, updatedAt: 1 }),
    );
    await assertFails(getDoc(doc(db(COMMENTER), artifactKvDoc(ART, COMMENTER, 'k'))));
    await assertFails(getDoc(doc(db(null), artifactKvDoc(ART, VIEWER, 'theme'))));
  });
});

describe('firestore · one artifact never opens another', () => {
  it('a role on ART gives nothing on OTHER', async () => {
    for (const uid of WITH_ROLE) {
      await assertFails(getDoc(doc(db(uid), `artifacts/${OTHER}`)));
      await assertFails(getDoc(doc(db(uid), `artifacts/${OTHER}/builds/build_0000000001`)));
      await assertFails(getDoc(doc(db(uid), artifactFirestoreDoc(OTHER, '/my/doc'))));
      await assertFails(getDocs(collection(db(uid), `${artifactPrefix.firestore(OTHER)}/my`)));
      await assertFails(setDoc(doc(db(uid), artifactFirestoreDoc(OTHER, '/w/x')), { n: 1 }));
      await assertFails(
        setDoc(doc(db(uid), artifactKvDoc(OTHER, uid, 'k')), { value: 1, updatedAt: 1 }),
      );
      await assertFails(getDoc(doc(db(uid), artifactKvDoc(OTHER, STRANGER, 'theme'))));
    }
  });

  it('and the owner of OTHER gets nothing on ART', async () => {
    await assertSucceeds(getDoc(doc(db(STRANGER), artifactFirestoreDoc(OTHER, '/my/doc'))));
    await assertFails(getDoc(doc(db(STRANGER), artifactFirestoreDoc(ART, '/my/doc'))));
    await assertFails(setDoc(doc(db(STRANGER), artifactFirestoreDoc(ART, '/w/x')), { n: 1 }));
  });

  it('no collection-group query reaches across artifacts', async () => {
    // Every one of these names a collection that exists under an artifact.
    for (const id of ['my', 'items', 'builds', 'kv', 'data', 'db'])
      for (const uid of [OWNER, VIEWER, STRANGER])
        await assertFails(getDocs(collectionGroup(db(uid), id)));
  });
});

describe('firestore · artifact invites', () => {
  it('the invitee (by verified address) and the artifact’s owner read one', async () => {
    await assertSucceeds(getDoc(doc(db(COMMENTER), 'invites/inv_art')));
    await assertSucceeds(getDoc(doc(db(OWNER), 'invites/inv_art')));
    await assertSucceeds(
      getDocs(query(collection(db(OWNER), 'invites'), where('artifactId', '==', ART))),
    );
  });

  it('editors, viewers and strangers do not', async () => {
    for (const uid of [EDITOR, VIEWER, STRANGER]) {
      await assertFails(getDoc(doc(db(uid), 'invites/inv_art')));
      await assertFails(
        getDocs(query(collection(db(uid), 'invites'), where('artifactId', '==', ART))),
      );
    }
  });

  it('a board admin still lists the board’s invites (the artifact clause changed nothing)', async () => {
    await assertSucceeds(
      getDocs(query(collection(db(ADMIN), 'invites'), where('boardId', '==', BOARD))),
    );
    await assertFails(
      getDocs(query(collection(db(VIEWER), 'invites'), where('boardId', '==', BOARD))),
    );
  });
});

// ═══════════════════════════════ Realtime Database ═══════════════════════════

describe('rtdb · artifactData', () => {
  const at = (a: string, p = '/counter') => artifactRtdbPath(a, p);

  it('every role reads the whole subtree; nobody else does', async () => {
    for (const a of MINE)
      for (const uid of WITH_ROLE) {
        await assertSucceeds(get(rref(rtdbOf(uid), at(a))));
        await assertSucceeds(get(rref(rtdbOf(uid), artifactPrefix.rtdb(a))));
      }
    for (const uid of OUTSIDERS) await assertFails(get(rref(rtdbOf(uid), at(ART))));
    // Never the parent of every artifact.
    await assertFails(get(rref(rtdbOf(OWNER), 'artifactData')));
  });

  it('ART: owner, editor and viewer write', async () => {
    for (const uid of WITH_ROLE) {
      await assertSucceeds(set(rref(rtdbOf(uid), at(ART, `/w/${uid}`)), { by: uid }));
      await assertSucceeds(update(rref(rtdbOf(uid), at(ART, `/w/${uid}`)), { n: 2 }));
      await assertSucceeds(remove(rref(rtdbOf(uid), at(ART, `/w/${uid}`))));
    }
  });

  it('RO: a read-only viewer cannot write; owner and editor can', async () => {
    await assertSucceeds(get(rref(rtdbOf(VIEWER), at(RO))));
    await assertFails(set(rref(rtdbOf(VIEWER), at(RO, '/w/v')), 1));
    await assertFails(remove(rref(rtdbOf(VIEWER), at(RO))));
    for (const uid of [OWNER, EDITOR])
      await assertSucceeds(set(rref(rtdbOf(uid), at(RO, `/w/${uid}`)), 1));
  });

  it('ARCH: nobody writes, everyone with a role still reads', async () => {
    for (const uid of WITH_ROLE) {
      await assertSucceeds(get(rref(rtdbOf(uid), at(ARCH))));
      await assertFails(set(rref(rtdbOf(uid), at(ARCH, `/w/${uid}`)), 1));
    }
  });

  it('a viewer fails CLOSED when the flags are missing; owner and editor are unaffected', async () => {
    await assertFails(set(rref(rtdbOf(VIEWER), at('art_noflag1', '/w/v')), 1));
    await assertSucceeds(set(rref(rtdbOf(EDITOR), at('art_noflag1', '/w/e')), 1));
  });

  it('nobody without a role writes, and a role on ART gives nothing on OTHER', async () => {
    for (const uid of OUTSIDERS) await assertFails(set(rref(rtdbOf(uid), at(ART, '/w/x')), 1));
    for (const uid of WITH_ROLE) {
      await assertFails(get(rref(rtdbOf(uid), at(OTHER))));
      await assertFails(set(rref(rtdbOf(uid), at(OTHER, '/w/x')), 1));
    }
    await assertSucceeds(get(rref(rtdbOf(STRANGER), at(OTHER))));
  });

  it('an agent’s live credential (uid = the agent id) is not a reader', async () => {
    const agent = rt(env.authenticatedContext('ag_0123456789abcdef', { board: BOARD }));
    await assertFails(get(rref(agent, at(ART))));
    await assertFails(set(rref(agent, at(ART, '/w/a')), 1));
  });
});

describe('rtdb · the mirrors are server-only', () => {
  it('nobody reads or writes artifactReaders / artifactFlags — a viewer cannot promote themselves', async () => {
    for (const uid of [OWNER, VIEWER, STRANGER, null]) {
      await assertFails(get(rref(rtdbOf(uid), artifactPrefix.rtdbReaders(ART))));
      await assertFails(get(rref(rtdbOf(uid), artifactPrefix.rtdbFlags(ART))));
    }
    await assertFails(
      set(rref(rtdbOf(VIEWER), `${artifactPrefix.rtdbReaders(ART)}/${VIEWER}`), 'owner'),
    );
    await assertFails(
      set(rref(rtdbOf(STRANGER), `${artifactPrefix.rtdbReaders(ART)}/${STRANGER}`), 'viewer'),
    );
    await assertFails(set(rref(rtdbOf(VIEWER), `${artifactPrefix.rtdbFlags(RO)}/readOnly`), false));
    await assertFails(
      set(rref(rtdbOf(OWNER), `${artifactPrefix.rtdbFlags(ARCH)}/archived`), false),
    );
  });
});

// ═══════════════════════════════════ Storage ═════════════════════════════════

describe('storage · files/ — the artifact’s own storage', () => {
  const upload = (uid: string | null, a: string, path: string, bytes: Uint8Array = png) =>
    uploadBytes(sref(storageOf(uid), artifactStorageFile(a, path)), bytes, {
      contentType: 'image/png',
    });

  it('ART: owner, editor and viewer upload, and may replace their file', async () => {
    for (const uid of WITH_ROLE) {
      await assertSucceeds(upload(uid, ART, `/up/${uid}.png`));
      await assertSucceeds(upload(uid, ART, `/up/${uid}.png`));
      await assertSucceeds(upload(uid, ART, `/deep/er/${uid}.png`));
    }
  });

  it('RO: a read-only viewer cannot upload; ARCH: nobody can', async () => {
    await assertFails(upload(VIEWER, RO, '/up/v.png'));
    await assertSucceeds(upload(EDITOR, RO, '/up/e.png'));
    for (const uid of WITH_ROLE) await assertFails(upload(uid, ARCH, `/up/${uid}.png`));
  });

  it('nobody without a role uploads; not to an artifact that does not exist; not across artifacts', async () => {
    for (const uid of OUTSIDERS) await assertFails(upload(uid, ART, '/up/x.png'));
    await assertFails(upload(REFUSED, ART, '/up/refused.png'));
    await assertFails(upload(OWNER, 'art_nope0001', '/up/x.png'));
    for (const uid of WITH_ROLE) await assertFails(upload(uid, OTHER, '/up/x.png'));
    await assertSucceeds(upload(STRANGER, OTHER, '/up/mine.png'));
  });

  it('25 MB is the limit', async () => {
    await assertFails(upload(OWNER, ART, '/up/big.bin', new Uint8Array(ARTIFACT_UPLOAD_MAX_BYTES)));
    await assertSucceeds(
      upload(OWNER, ART, '/up/ok.bin', new Uint8Array(ARTIFACT_UPLOAD_MAX_BYTES - 1)),
    );
  }, 120_000);

  it('no client reads, lists or deletes — those are commands (the owner included)', async () => {
    const existing = artifactStorageFile(ART, '/pics/cat.png');
    for (const uid of [OWNER, VIEWER, STRANGER, null]) {
      await assertFails(getMetadata(sref(storageOf(uid), existing)));
      await assertFails(getBytes(sref(storageOf(uid), existing)));
      await assertFails(deleteObject(sref(storageOf(uid), existing)));
      await assertFails(listAll(sref(storageOf(uid), artifactPrefix.storageFiles(ART))));
    }
  });
});

describe('storage · uploads/ — a build zip on its way to artifactPublish', () => {
  const put = (uid: string | null, a: string, id: string, bytes: Uint8Array = zip) =>
    uploadBytes(sref(storageOf(uid), artifactPrefix.storageUpload(a, id)), bytes, {
      contentType: 'application/zip',
    });

  it('owner and editor put a zip; a viewer and everyone else do not', async () => {
    await assertSucceeds(put(OWNER, ART, 'up_owner'));
    await assertSucceeds(put(EDITOR, ART, 'up_editor'));
    await assertFails(put(VIEWER, ART, 'up_viewer'));
    for (const uid of OUTSIDERS) await assertFails(put(uid, ART, 'up_x'));
    await assertFails(put(OWNER, OTHER, 'up_cross'));
    await assertFails(put(OWNER, ARCH, 'up_arch'));
  });

  it('written once, only as {id}.zip, and never read back', async () => {
    await assertFails(put(OWNER, ART, 'taken'));
    await assertFails(
      uploadBytes(sref(storageOf(OWNER), `${artifactPrefix.storageUploads(ART)}evil.html`), png),
    );
    await assertFails(
      uploadBytes(sref(storageOf(OWNER), `${artifactPrefix.storageUploads(ART)}a/b.zip`), zip),
    );
    const taken = artifactPrefix.storageUpload(ART, 'taken');
    await assertFails(getBytes(sref(storageOf(OWNER), taken)));
    await assertFails(deleteObject(sref(storageOf(OWNER), taken)));
  });
});

describe('storage · builds/ and source/ are the server’s', () => {
  it('no client reads or writes a build file or a source zip', async () => {
    const build = `${artifactPrefix.storageBuild(ART, 'b1')}/index.html`;
    const source = artifactPrefix.storageSource(ART, 'b1');
    for (const uid of [OWNER, EDITOR, VIEWER, STRANGER, null]) {
      await assertFails(getBytes(sref(storageOf(uid), build)));
      await assertFails(getBytes(sref(storageOf(uid), source)));
      await assertFails(uploadBytes(sref(storageOf(uid), build), png));
      await assertFails(
        uploadBytes(
          sref(storageOf(uid), `${artifactPrefix.storageBuild(ART, 'b2')}/index.html`),
          png,
        ),
      );
      await assertFails(
        uploadBytes(sref(storageOf(uid), artifactPrefix.storageSource(ART, 'b2')), zip),
      );
      await assertFails(deleteObject(sref(storageOf(uid), build)));
    }
    // And nothing loose directly under the artifact.
    await assertFails(uploadBytes(sref(storageOf(OWNER), `artifacts/${ART}/loose.png`), png));
  });
});

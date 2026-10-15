/**
 * BUCKET (docs/plan/bucket.html §A, §B) — the rules:
 *
 *   Firestore  buckets/{m} and its nodes: the bucket's PEOPLE read them;
 *              nobody writes them (the commands do)
 *   Storage    buckets/{m}/{fileId}/{name}: owner and editor CREATE a new
 *              version once; nobody reads, updates or deletes through rules
 *
 * Being on a board the bucket is GRANTED to gives nothing here: those
 * readers go through bucketTree / the file door (a rule cannot ask "is this
 * person on any granted board").
 *
 * EXCEPT a ticket attachment (§J): an upload that names a board in its
 * metadata ({ boardId }) may be created by that board's admin / editor /
 * commenter when the bucket is granted `write` to it (and is not archived).
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { getBytes, ref as sref, uploadBytes } from 'firebase/storage';
import { bucketStoragePath } from '@tm/shared';
import { fixtures } from '@tm/shared/schema/fixtures';
import {
  ADMIN,
  BOARD,
  COMMENTER,
  EDITOR,
  OTHER_BOARD,
  ROLES,
  STRANGER,
  VIEWER,
  as,
  boardDoc,
  fs,
  makeEnv,
  st,
} from './_env.js';

const OWNER = ADMIN;
const MEM = 'mem_alpha01';
const ARCH = 'mem_archv01';
/** Granted READ to BOARD: no ticket attachments go there. */
const READ_ONLY = 'mem_readg01';

type Role = 'owner' | 'editor' | 'viewer';
const CAST: Record<string, Role> = { [OWNER]: 'owner', [EDITOR]: 'editor', [VIEWER]: 'viewer' };

function bucketDoc(over: Record<string, unknown> = {}) {
  return {
    ...fixtures.buckets,
    ownerUid: OWNER,
    access: CAST,
    memberUids: Object.keys(CAST).sort(),
    // COMMENTER is on BOARD, which the bucket is granted to — still no rules access.
    boards: { [BOARD]: 'write' },
    boardIds: [BOARD],
    archivedAt: null,
    ...over,
  };
}

const bytes = new Uint8Array([0x23, 0x20, 0x68, 0x69]);
let env: RulesTestEnvironment;
const ctxOf = (uid: string | null) => (uid ? as(env, uid) : env.unauthenticatedContext());
const db = (uid: string | null) => fs(ctxOf(uid));
const storageOf = (uid: string | null) => st(ctxOf(uid));
const EXISTING = bucketStoragePath(MEM, 'file_existing1', 'notes.md');

beforeAll(async () => {
  env = await makeEnv({ firestore: true, storage: true });
  await env.clearFirestore();
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(fs(ctx), `buckets/${MEM}`), bucketDoc());
    await setDoc(doc(fs(ctx), `buckets/${ARCH}`), bucketDoc({ archivedAt: 1 }));
    await setDoc(
      doc(fs(ctx), `buckets/${READ_ONLY}`),
      bucketDoc({ boards: { [BOARD]: 'read' }, boardIds: [BOARD] }),
    );
    await setDoc(doc(fs(ctx), `boards/${BOARD}`), boardDoc(ROLES));
    // STRANGER is the admin of a board the bucket is NOT granted to.
    await setDoc(
      doc(fs(ctx), `boards/${OTHER_BOARD}`),
      boardDoc({ [STRANGER]: 'admin' }, 'Ops', 'OPS'),
    );
    await setDoc(doc(fs(ctx), `buckets/${MEM}/nodes/node_one01`), fixtures.bucketNodes);
    await uploadBytes(sref(st(ctx), EXISTING), bytes, { contentType: 'text/markdown' });
  });
});

afterAll(async () => {
  await env?.cleanup();
});

describe('Firestore: buckets/{m} and its nodes', () => {
  it('its people read the bucket and its nodes', async () => {
    for (const uid of Object.keys(CAST)) {
      await assertSucceeds(getDoc(doc(db(uid), `buckets/${MEM}`)));
      await assertSucceeds(getDoc(doc(db(uid), `buckets/${MEM}/nodes/node_one01`)));
      await assertSucceeds(getDocs(collection(db(uid), `buckets/${MEM}/nodes`)));
    }
  });
  it('a list is provable only by memberUids', async () => {
    await assertSucceeds(
      getDocs(
        query(collection(db(VIEWER), 'buckets'), where('memberUids', 'array-contains', VIEWER)),
      ),
    );
    await assertFails(getDocs(collection(db(VIEWER), 'buckets')));
  });
  it('a member of a granted board, a stranger and the signed-out read nothing', async () => {
    for (const uid of [COMMENTER, STRANGER, null]) {
      await assertFails(getDoc(doc(db(uid), `buckets/${MEM}`)));
      await assertFails(getDoc(doc(db(uid), `buckets/${MEM}/nodes/node_one01`)));
    }
  });
  it('nobody writes through the rules, the owner included', async () => {
    await assertFails(setDoc(doc(db(OWNER), `buckets/${MEM}`), bucketDoc({ name: 'x' })));
    await assertFails(setDoc(doc(db(OWNER), `buckets/${MEM}/nodes/n2`), fixtures.bucketNodes));
    await assertFails(setDoc(doc(db(OWNER), 'buckets/mem_new0001'), bucketDoc()));
  });
});

describe('Storage: buckets/{m}/{fileId}/{name}', () => {
  const up = (uid: string | null, m: string, fileId: string) =>
    uploadBytes(sref(storageOf(uid), bucketStoragePath(m, fileId, 'a.md')), bytes, {
      contentType: 'text/markdown',
    });
  it('owner and editor upload a new version', async () => {
    await assertSucceeds(up(OWNER, MEM, 'file_owner001'));
    await assertSucceeds(up(EDITOR, MEM, 'file_editor01'));
  });
  it('a viewer, a granted board member and a stranger cannot', async () => {
    for (const uid of [VIEWER, COMMENTER, STRANGER, null])
      await assertFails(up(uid, MEM, `file_${uid ?? 'anon'}_x`));
  });
  it('nobody uploads into an archived bucket', async () => {
    await assertFails(up(OWNER, ARCH, 'file_arch0001'));
  });
  it('a version is written once', async () => {
    await assertFails(
      uploadBytes(sref(storageOf(OWNER), EXISTING), bytes, { contentType: 'text/markdown' }),
    );
  });
  it('a file id must be an id', async () => {
    await assertFails(up(OWNER, MEM, 'x'));
  });
  it('nobody reads the bytes through the rules (the file door does)', async () => {
    for (const uid of [OWNER, EDITOR, VIEWER])
      await assertFails(getBytes(sref(storageOf(uid), EXISTING)));
  });
});

describe('Storage: a ticket attachment into a bucket (§J)', () => {
  const upFor = (uid: string | null, m: string, fileId: string, boardId: string | null) =>
    uploadBytes(sref(storageOf(uid), bucketStoragePath(m, fileId, 'shot.png')), bytes, {
      contentType: 'image/png',
      ...(boardId ? { customMetadata: { boardId } } : {}),
    });
  it("the board's admin, editor and commenter upload into a bucket granted write", async () => {
    for (const uid of [ADMIN, EDITOR, COMMENTER])
      await assertSucceeds(upFor(uid, MEM, `file_bd_${uid}`, BOARD));
  });
  it('not without naming the board (a commenter has no role on the bucket)', async () => {
    await assertFails(upFor(COMMENTER, MEM, 'file_nobd01', null));
  });
  it('a board viewer, a stranger and the signed-out cannot', async () => {
    for (const uid of [VIEWER, STRANGER, null])
      await assertFails(upFor(uid, MEM, `file_bv_${uid ?? 'anon'}`, BOARD));
  });
  it("not into a bucket granted only read, or one that isn't granted to that board", async () => {
    await assertFails(upFor(COMMENTER, READ_ONLY, 'file_ro0001', BOARD));
    await assertFails(upFor(STRANGER, MEM, 'file_other01', OTHER_BOARD));
  });
  it('not into an archived bucket', async () => {
    await assertFails(upFor(COMMENTER, ARCH, 'file_arch0002', BOARD));
  });
});

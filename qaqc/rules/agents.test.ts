/**
 * Phase 2 (docs/plan/agents.html §B–D) — agent profiles, the agent inbox, an
 * agent on a board, and agent avatars in Storage.
 *
 *   agents/{agentId}                 only the owner reads (get, list where ownerUid == me); no client writes
 *   agentInbox/{agentId}/events/*    server only (read through the API with the agent's token)
 *   boards/{b}/members/{agentId}     readable by the board's people like any member row
 *   an agent id in board.access      is never a reader: the rules never see agents
 *   users/{owner}/agents/{id}/avatar the owner uploads; anyone signed in reads
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { deleteObject, getMetadata, ref, uploadBytes } from 'firebase/storage';
import { storage as spaths } from '@tm/shared';
import { fixtures } from '@tm/shared/schema/fixtures';
import {
  ADMIN,
  BOARD,
  EDITOR,
  ROLES,
  STRANGER,
  VIEWER,
  as,
  boardDoc,
  fs,
  makeEnv,
  st,
} from './_env.js';

let env: RulesTestEnvironment;

const AGENT = 'ag_Builder000000000'; // 'ag_' + 16
const OTHER_AGENT = 'ag_Strangr000000000';
const db = (uid: string | null) => fs(uid ? as(env, uid) : env.unauthenticatedContext());
const storageOf = (uid: string | null) => st(uid ? as(env, uid) : env.unauthenticatedContext());
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const upload = (uid: string | null, path: string, contentType = 'image/png', bytes = png) =>
  uploadBytes(ref(storageOf(uid), path), bytes, { contentType });

beforeAll(async () => {
  env = await makeEnv({ firestore: true, storage: true });
  await env.clearFirestore();
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = fs(ctx);
    const put = (path: string, data: object) => setDoc(doc(d, path), data);
    await put(`agents/${AGENT}`, { ...fixtures.agents, ownerUid: ADMIN });
    await put(`agents/${OTHER_AGENT}`, { ...fixtures.agents, ownerUid: STRANGER });
    await put(`agentInbox/${AGENT}/events/000000001_a`, { ...fixtures.agentInbox, boardId: BOARD });

    // The agent holds an editor role in access, but readerUids stays people-only.
    const access = { ...ROLES, [AGENT]: 'editor' };
    const people = boardDoc(ROLES);
    await put(`boards/${BOARD}`, { ...people, access });
    await put(`boards/${BOARD}/members/${AGENT}`, {
      ...fixtures.members,
      kind: 'agent',
      uid: AGENT,
      role: 'editor',
      email: '',
      invitedBy: null,
      ownerUid: ADMIN,
      addedBy: ADMIN,
    });
    await uploadBytes(ref(st(ctx), spaths.agentAvatar(ADMIN, AGENT, 1)), png, {
      contentType: 'image/png',
    });
  });
});

afterAll(async () => {
  await env?.cleanup();
});

describe('agents/{agentId}', () => {
  it('the owner gets it', async () => {
    await assertSucceeds(getDoc(doc(db(ADMIN), `agents/${AGENT}`)));
  });
  it('nobody else does — not the board it is on, not a stranger, not signed out', async () => {
    for (const uid of [EDITOR, VIEWER, STRANGER, null])
      await assertFails(getDoc(doc(db(uid), `agents/${AGENT}`)));
  });
  it('the owner lists their own agents (where ownerUid == me)', async () => {
    await assertSucceeds(
      getDocs(query(collection(db(ADMIN), 'agents'), where('ownerUid', '==', ADMIN))),
    );
  });
  it('an unfiltered list, or someone else’s, is refused', async () => {
    await assertFails(getDocs(collection(db(ADMIN), 'agents')));
    await assertFails(
      getDocs(query(collection(db(ADMIN), 'agents'), where('ownerUid', '==', STRANGER))),
    );
  });
  it('no client writes, not even the owner (agentCreate / agentUpdate / agentArchive)', async () => {
    await assertFails(
      setDoc(doc(db(ADMIN), 'agents/ag_New0000000000000'), { ...fixtures.agents, ownerUid: ADMIN }),
    );
    await assertFails(updateDoc(doc(db(ADMIN), `agents/${AGENT}`), { name: 'Renamed' }));
    await assertFails(deleteDoc(doc(db(ADMIN), `agents/${AGENT}`)));
  });
});

describe('agentInbox/{agentId}/events', () => {
  it('server only: the owner cannot read or ack in the client', async () => {
    await assertFails(getDoc(doc(db(ADMIN), `agentInbox/${AGENT}/events/000000001_a`)));
    await assertFails(getDocs(collection(db(ADMIN), `agentInbox/${AGENT}/events`)));
    await assertFails(
      updateDoc(doc(db(ADMIN), `agentInbox/${AGENT}/events/000000001_a`), { ackedAt: 5 }),
    );
    await assertFails(setDoc(doc(db(ADMIN), `agentInbox/${AGENT}/events/x`), fixtures.agentInbox));
    await assertFails(getDoc(doc(db(ADMIN), `agentInbox/${AGENT}`)));
  });
});

describe('an agent on a board', () => {
  it('its members/ row is readable by the board’s people', async () => {
    await assertSucceeds(getDoc(doc(db(VIEWER), `boards/${BOARD}/members/${AGENT}`)));
    await assertFails(getDoc(doc(db(STRANGER), `boards/${BOARD}/members/${AGENT}`)));
  });
  it('an agent id authenticating directly is not a reader (agents never sign in)', async () => {
    await assertFails(getDoc(doc(db(AGENT), `boards/${BOARD}`)));
    await assertFails(getDoc(doc(db(AGENT), `boards/${BOARD}/members/${AGENT}`)));
  });
});

describe('agent avatars (Storage)', () => {
  it('the owner uploads under their own prefix, before or after the profile exists', async () => {
    await assertSucceeds(upload(ADMIN, spaths.agentAvatar(ADMIN, AGENT, 2)));
    await assertSucceeds(upload(ADMIN, spaths.agentAvatar(ADMIN, 'ag_Later00000000000', 1)));
  });
  it('nobody uploads under someone else’s prefix', async () => {
    await assertFails(upload(EDITOR, spaths.agentAvatar(ADMIN, AGENT, 3)));
    await assertFails(upload(null, spaths.agentAvatar(ADMIN, AGENT, 3)));
  });
  it('images only, under 5 MB, and a real agent id', async () => {
    await assertFails(upload(ADMIN, spaths.agentAvatar(ADMIN, AGENT, 4), 'text/html'));
    await assertFails(
      upload(
        ADMIN,
        spaths.agentAvatar(ADMIN, AGENT, 5),
        'image/png',
        new Uint8Array(5 * 1024 * 1024 + 1),
      ),
    );
    await assertFails(upload(ADMIN, `users/${ADMIN}/agents/not-an-agent/avatar/1.webp`));
  });
  it('any signed-in person reads (it is shown on boards); signed out does not', async () => {
    await assertSucceeds(
      getMetadata(ref(storageOf(STRANGER), spaths.agentAvatar(ADMIN, AGENT, 1))),
    );
    await assertFails(getMetadata(ref(storageOf(null), spaths.agentAvatar(ADMIN, AGENT, 1))));
  });
  it('only the owner deletes', async () => {
    await assertFails(deleteObject(ref(storageOf(EDITOR), spaths.agentAvatar(ADMIN, AGENT, 1))));
    await assertSucceeds(deleteObject(ref(storageOf(ADMIN), spaths.agentAvatar(ADMIN, AGENT, 1))));
  });
});

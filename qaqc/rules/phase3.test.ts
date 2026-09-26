/**
 * Phase 3 (docs/plan/agents.html §L) — what the new documents let a client do.
 *
 *   task lists (§L2) — phase 15 (§W) folded them INTO the ticket document, so
 *                      they are read with the ticket and written by nobody;
 *                      the old subcollection is denied like any unknown path
 *   boards/{b}/agentStatus/{agentId}__{t|'_'}   everyone on the board reads,
 *                                               including a LIST (the board
 *                                               listens to it once, §L3);
 *                                               no client writes
 *   the question lives on its message, which lives on the ticket, so it needs
 *   no rule of its own — but a person may not tick a task list, answer a
 *   question or fake a heartbeat by writing Firestore directly.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { agentStatusId } from '@tm/shared';
import { fixtures, questionMessageFixture } from '@tm/shared/schema/fixtures';
import {
  ADMIN,
  BOARD,
  COMMENTER,
  EDITOR,
  EVERYONE,
  MEMBERS,
  ROLES,
  STRANGER,
  TICKET,
  VIEWER,
  as,
  boardDoc,
  fs,
  makeEnv,
} from './_env.js';

let env: RulesTestEnvironment;

const AGENT = 'ag_Builder000000000';
const LIST = 'tl_plan1';
const STATUS = agentStatusId(AGENT, TICKET);
const AGENT_LEVEL = agentStatusId(AGENT, null);
const db = (uid: string | null) => fs(uid ? as(env, uid) : env.unauthenticatedContext());

const ticketPath = `boards/${BOARD}/tickets/${TICKET}`;
/** The collection task lists lived in before §W — now an unknown path. */
const listPath = `boards/${BOARD}/tickets/${TICKET}/tasklists/${LIST}`;
const statusPath = `boards/${BOARD}/agentStatus/${STATUS}`;

beforeAll(async () => {
  env = await makeEnv({ firestore: true });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = fs(ctx);
    const put = (path: string, data: object) => setDoc(doc(d, path), data);
    await put(`boards/${BOARD}`, { ...boardDoc(ROLES), access: { ...ROLES, [AGENT]: 'editor' } });
    await put(`boards/${BOARD}/tickets/${TICKET}`, { ...fixtures.tickets, key: 'ENG-1' });
    await put(`boards/${BOARD}/tickets/${TICKET}/data/000`, fixtures.ticketData);
    await put(statusPath, { ...fixtures.agentStatus, agentId: AGENT, ticketId: TICKET });
    await put(`boards/${BOARD}/agentStatus/${AGENT_LEVEL}`, {
      ...fixtures.agentStatus,
      agentId: AGENT,
      ticketId: null,
    });
  });
});

afterAll(async () => {
  await env?.cleanup();
});

describe('task lists live on the ticket (§L2 · §W)', () => {
  it('everyone on the board reads them — by reading the ticket', async () => {
    for (const uid of MEMBERS) await assertSucceeds(getDoc(doc(db(uid), ticketPath)));
  });

  it('a stranger and a signed-out client read nothing', async () => {
    for (const uid of [STRANGER, null]) await assertFails(getDoc(doc(db(uid), ticketPath)));
  });

  it('no client writes one — not even an admin ticking an item by hand', async () => {
    for (const uid of [ADMIN, EDITOR, COMMENTER, VIEWER, STRANGER, null]) {
      await assertFails(updateDoc(doc(db(uid), ticketPath), { tasklists: [] }));
      // …and the collection it used to live in is denied outright.
      await assertFails(setDoc(doc(db(uid), listPath), { ...fixtures.tasklists, owner: AGENT }));
      await assertFails(getDoc(doc(db(uid), listPath)));
    }
  });
});

describe('ticket data pages (§W)', () => {
  const pagePath = `boards/${BOARD}/tickets/${TICKET}/data/000`;
  it('everyone on the board may page back; a stranger may not', async () => {
    for (const uid of MEMBERS) await assertSucceeds(getDoc(doc(db(uid), pagePath)));
    for (const uid of [STRANGER, null]) await assertFails(getDoc(doc(db(uid), pagePath)));
  });
  it('nobody writes a page', async () => {
    for (const uid of MEMBERS) {
      await assertFails(setDoc(doc(db(uid), pagePath), fixtures.ticketData));
      await assertFails(deleteDoc(doc(db(uid), pagePath)));
    }
  });
});

describe('agentStatus (§L3)', () => {
  it('the board listens to it once: every member may list and get', async () => {
    for (const uid of MEMBERS) {
      await assertSucceeds(getDocs(collection(db(uid), `boards/${BOARD}/agentStatus`)));
      await assertSucceeds(getDoc(doc(db(uid), statusPath)));
      await assertSucceeds(getDoc(doc(db(uid), `boards/${BOARD}/agentStatus/${AGENT_LEVEL}`)));
    }
  });

  it('a stranger and a signed-out client see nothing', async () => {
    for (const uid of [STRANGER, null]) {
      await assertFails(getDocs(collection(db(uid), `boards/${BOARD}/agentStatus`)));
      await assertFails(getDoc(doc(db(uid), statusPath)));
    }
  });

  it('nobody fakes a beat: every client write is refused', async () => {
    for (const uid of EVERYONE.concat([null as unknown as string])) {
      await assertFails(
        setDoc(doc(db(uid), `boards/${BOARD}/agentStatus/${agentStatusId(AGENT, 'tkt_9999')}`), {
          ...fixtures.agentStatus,
          agentId: AGENT,
        }),
      );
      await assertFails(updateDoc(doc(db(uid), statusPath), { state: 'done' }));
      await assertFails(deleteDoc(doc(db(uid), statusPath)));
    }
  });
});

describe('questions live on their message (§L1), which lives on the ticket (§W)', () => {
  it('the card is read with the ticket and written by nobody', async () => {
    await env.withSecurityRulesDisabled(async (ctx) =>
      setDoc(doc(fs(ctx), ticketPath), {
        ...fixtures.tickets,
        key: 'ENG-1',
        recentMessages: [{ ...questionMessageFixture, id: 'msg_q' }],
      }),
    );
    await assertSucceeds(getDoc(doc(db(COMMENTER), ticketPath)));
    await assertFails(getDoc(doc(db(STRANGER), ticketPath)));
    // Answering is questionAnswer, never a direct write.
    await assertFails(updateDoc(doc(db(COMMENTER), ticketPath), { recentMessages: [] }));
  });
});

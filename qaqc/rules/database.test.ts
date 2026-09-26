/**
 * database.rules.json — presence and typing, gated by the boardReaders mirror
 * (RTDB rules cannot read Firestore); rate/ and boardReaders/ server-only.
 *
 * PLUS THE LIVE TREE (docs/plan/agents.html §W): status/{boardId}/{agentId}/…,
 * rev/{boardId} and agents/{agentId}/wake. Two kinds of principal reach it:
 *
 *   a PERSON, by the boardReaders mirror, exactly like presence;
 *   an AGENT, by a BOARD-SCOPED credential — uid = the agent id, `board`
 *     claim = the one board it was issued for. It may read that board's
 *     status and rev and write only its OWN status under it.
 *
 * silence/ is the sweep's own bookkeeping and is closed to every client, so a
 * beat can neither erase nor forge 'the owner has already been told'.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { get, ref, remove, serverTimestamp, set, update } from 'firebase/database';
import { live, rtdb, rateBuckets, statusKey } from '@tm/shared';
import {
  ADMIN,
  BOARD,
  MEMBERS,
  OTHER_BOARD,
  STRANGER,
  TICKET,
  VIEWER,
  as,
  makeEnv,
  rt,
} from './_env.js';

let env: RulesTestEnvironment;

const dbOf = (uid: string | null) => rt(uid ? as(env, uid) : env.unauthenticatedContext());
const presence = (state = 'online') => ({ state, viewing: TICKET, lastChanged: serverTimestamp() });

/** The agent on BOARD, and one that was issued a credential for another board. */
const AGENT = 'ag_0123456789abcdef';
const OTHER_AGENT = 'ag_fedcba9876543210';
/** A board-scoped agent credential: its uid IS the agent id. */
const asAgent = (agentId: string, boardId: string) =>
  rt(env.authenticatedContext(agentId, { board: boardId }));
const beat = (over: Record<string, unknown> = {}) => ({
  state: 'working',
  message: 'Running tests (3/12)',
  progress: 0.25,
  at: 1_000,
  startedAt: 1_000,
  ticketId: TICKET,
  ...over,
});

beforeAll(async () => {
  env = await makeEnv({ database: true });
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = rt(ctx);
    for (const uid of MEMBERS) await set(ref(d, rtdb.boardReader(BOARD, uid)), true);
    await set(ref(d, rtdb.presence(BOARD, ADMIN)), {
      state: 'online',
      viewing: null,
      lastChanged: 1,
    });
    await set(ref(d, rtdb.typing(BOARD, TICKET, ADMIN)), { at: 1 });
    await set(ref(d, rtdb.rate(rateBuckets.apiKey('k1'), 100)), 3);
    await set(ref(d, live.status(BOARD, AGENT, TICKET)), beat());
    await set(ref(d, live.rev(BOARD)), { at: 1_000, by: ADMIN });
    await set(ref(d, live.wake(AGENT)), { at: 1_000, boardId: BOARD });
    await set(ref(d, live.silence(BOARD, AGENT, TICKET)), { notifiedAt: 1_000 });
  });
});

afterAll(async () => {
  await env?.cleanup();
});

describe('presence', () => {
  it('every board reader sees who is here', async () => {
    for (const uid of MEMBERS) await assertSucceeds(get(ref(dbOf(uid), rtdb.presenceBoard(BOARD))));
  });
  it('a stranger and signed-out do not', async () => {
    await assertFails(get(ref(dbOf(STRANGER), rtdb.presenceBoard(BOARD))));
    await assertFails(get(ref(dbOf(null), rtdb.presenceBoard(BOARD))));
    await assertFails(get(ref(dbOf(VIEWER), 'presence')));
  });
  it('a reader writes and clears their own presence', async () => {
    await assertSucceeds(set(ref(dbOf(VIEWER), rtdb.presence(BOARD, VIEWER)), presence()));
    await assertSucceeds(
      set(ref(dbOf(VIEWER), rtdb.presence(BOARD, VIEWER)), { state: 'away', lastChanged: 5 }),
    );
    await assertSucceeds(remove(ref(dbOf(VIEWER), rtdb.presence(BOARD, VIEWER))));
  });
  it('not someone else’s, not on a board they cannot read, not malformed', async () => {
    await assertFails(set(ref(dbOf(VIEWER), rtdb.presence(BOARD, ADMIN)), presence()));
    await assertFails(remove(ref(dbOf(VIEWER), rtdb.presence(BOARD, ADMIN))));
    await assertFails(set(ref(dbOf(STRANGER), rtdb.presence(BOARD, STRANGER)), presence()));
    await assertFails(set(ref(dbOf(VIEWER), rtdb.presence(BOARD, VIEWER)), presence('busy')));
    await assertFails(
      set(ref(dbOf(VIEWER), rtdb.presence(BOARD, VIEWER)), { ...presence(), extra: 1 }),
    );
    await assertFails(set(ref(dbOf(VIEWER), rtdb.presence(BOARD, VIEWER)), { state: 'online' }));
  });
  it('someone removed from a board can still clear their stale presence', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      set(ref(rt(ctx), rtdb.presence(BOARD, STRANGER)), { state: 'online', lastChanged: 1 }),
    );
    await assertSucceeds(remove(ref(dbOf(STRANGER), rtdb.presence(BOARD, STRANGER))));
  });
});

describe('typing', () => {
  it('board readers read and write their own typing flag', async () => {
    await assertSucceeds(get(ref(dbOf(VIEWER), rtdb.typingTicket(BOARD, TICKET))));
    await assertSucceeds(
      set(ref(dbOf(VIEWER), rtdb.typing(BOARD, TICKET, VIEWER)), { at: serverTimestamp() }),
    );
    await assertSucceeds(remove(ref(dbOf(VIEWER), rtdb.typing(BOARD, TICKET, VIEWER))));
  });
  it('strangers, other people’s flags and malformed flags are refused', async () => {
    await assertFails(get(ref(dbOf(STRANGER), rtdb.typingTicket(BOARD, TICKET))));
    await assertFails(set(ref(dbOf(STRANGER), rtdb.typing(BOARD, TICKET, STRANGER)), { at: 1 }));
    await assertFails(set(ref(dbOf(VIEWER), rtdb.typing(BOARD, TICKET, ADMIN)), { at: 1 }));
    await assertFails(set(ref(dbOf(VIEWER), rtdb.typing(BOARD, TICKET, VIEWER)), { at: 'now' }));
    await assertFails(
      set(ref(dbOf(VIEWER), rtdb.typing(BOARD, TICKET, VIEWER)), { at: 1, text: 'hi' }),
    );
  });
});

describe('server-only paths', () => {
  it('boardReaders is neither readable nor writable by clients', async () => {
    await assertFails(get(ref(dbOf(ADMIN), rtdb.boardReaders(BOARD))));
    await assertFails(get(ref(dbOf(ADMIN), rtdb.boardReader(BOARD, ADMIN))));
    await assertFails(set(ref(dbOf(STRANGER), rtdb.boardReader(BOARD, STRANGER)), true));
  });
  it('rate/ is Admin SDK only', async () => {
    const path = rtdb.rate(rateBuckets.apiKey('k1'), 100);
    await assertFails(get(ref(dbOf(ADMIN), path)));
    await assertFails(set(ref(dbOf(ADMIN), path), 0));
    await assertFails(get(ref(dbOf(ADMIN), 'rate')));
  });
  it('the root and unknown paths are closed', async () => {
    await assertFails(get(ref(dbOf(ADMIN), '/')));
    await assertFails(set(ref(dbOf(ADMIN), 'anything'), 1));
  });
});

describe('status — the heartbeat (§W)', () => {
  it('every board reader sees what the agents on their board are doing', async () => {
    for (const uid of MEMBERS) await assertSucceeds(get(ref(dbOf(uid), live.boardStatus(BOARD))));
    await assertSucceeds(get(ref(dbOf(VIEWER), live.status(BOARD, AGENT, TICKET))));
  });

  it('a stranger, a signed-out reader and the whole tree do not', async () => {
    await assertFails(get(ref(dbOf(STRANGER), live.boardStatus(BOARD))));
    await assertFails(get(ref(dbOf(null), live.boardStatus(BOARD))));
    await assertFails(get(ref(dbOf(ADMIN), live.statusRoot())));
  });

  it('a board-scoped agent credential reads its board and writes its own beat', async () => {
    const d = asAgent(AGENT, BOARD);
    await assertSucceeds(get(ref(d, live.boardStatus(BOARD))));
    await assertSucceeds(set(ref(d, live.status(BOARD, AGENT, TICKET)), beat({ at: 2_000 })));
    // An agent-level beat (no ticket) drops the ticketId child entirely.
    await assertSucceeds(
      set(ref(d, live.status(BOARD, AGENT, null)), { state: 'idle', at: 2_000, startedAt: 2_000 }),
    );
    await assertSucceeds(remove(ref(d, live.status(BOARD, AGENT, null))));
  });

  it('nobody writes a beat that is not their own', async () => {
    // Not another agent's, on the same board.
    await assertFails(
      set(ref(asAgent(AGENT, BOARD), live.status(BOARD, OTHER_AGENT, TICKET)), beat()),
    );
    // Not on a board this credential was not issued for.
    await assertFails(
      set(ref(asAgent(AGENT, OTHER_BOARD), live.status(BOARD, AGENT, TICKET)), beat()),
    );
    // Not a person, however senior: the admin clears a stuck run through the API.
    await assertFails(set(ref(dbOf(ADMIN), live.status(BOARD, AGENT, TICKET)), beat()));
    await assertFails(set(ref(dbOf(STRANGER), live.status(BOARD, AGENT, TICKET)), beat()));
    await assertFails(set(ref(dbOf(null), live.status(BOARD, AGENT, TICKET)), beat()));
  });

  it('a malformed beat is refused', async () => {
    const d = asAgent(AGENT, BOARD);
    const bad = (o: Record<string, unknown>) =>
      assertFails(set(ref(d, live.status(BOARD, AGENT, TICKET)), o));
    await bad(beat({ state: 'thinking' }));
    await bad(beat({ progress: 2 }));
    await bad(beat({ at: 'now' }));
    await bad(beat({ message: 'x'.repeat(201) }));
    await bad(beat({ extra: 1 }));
    // `at` and `startedAt` are what staleness is derived from: neither is optional.
    await bad({ state: 'working', startedAt: 1_000 });
    await bad({ state: 'working', at: 1_000 });
    // And the far future is not a beat.
    await bad(beat({ at: Date.now() + 10 * 60_000 }));
  });
});

describe('rev — the board revision (§W)', () => {
  it('whoever may read the board may watch its revision', async () => {
    for (const uid of MEMBERS) await assertSucceeds(get(ref(dbOf(uid), live.rev(BOARD))));
    await assertSucceeds(get(ref(asAgent(AGENT, BOARD), live.rev(BOARD))));
  });

  it('nobody else may read it, and NOBODY may write it', async () => {
    await assertFails(get(ref(dbOf(STRANGER), live.rev(BOARD))));
    await assertFails(get(ref(dbOf(null), live.rev(BOARD))));
    await assertFails(get(ref(dbOf(ADMIN), live.revRoot())));
    await assertFails(get(ref(asAgent(AGENT, OTHER_BOARD), live.rev(BOARD))));
    // Only the command layer bumps it — a client that could would be able to
    // make every open tab re-query the board at will.
    await assertFails(set(ref(dbOf(ADMIN), live.rev(BOARD)), { at: 2_000 }));
    await assertFails(set(ref(asAgent(AGENT, BOARD), live.rev(BOARD)), { at: 2_000 }));
  });
});

describe('agents/{agentId}/wake (§W)', () => {
  it('an agent hears its own wake and nobody else hears it', async () => {
    await assertSucceeds(get(ref(asAgent(AGENT, BOARD), live.wake(AGENT))));
    await assertFails(get(ref(asAgent(OTHER_AGENT, BOARD), live.wake(AGENT))));
    await assertFails(get(ref(dbOf(ADMIN), live.wake(AGENT))));
    await assertFails(get(ref(dbOf(ADMIN), live.agentRoot(AGENT))));
    await assertFails(get(ref(dbOf(null), live.wake(AGENT))));
  });

  it('only the server writes it', async () => {
    await assertFails(set(ref(asAgent(AGENT, BOARD), live.wake(AGENT)), { at: 2_000 }));
    await assertFails(update(ref(dbOf(ADMIN)), { [live.wake(AGENT)]: { at: 2_000 } }));
  });
});

describe('silence/ — the sweep’s bookkeeping (§W)', () => {
  it('is closed to every client, so a beat can neither read nor forge it', async () => {
    const path = live.silence(BOARD, AGENT, TICKET);
    await assertFails(get(ref(asAgent(AGENT, BOARD), path)));
    await assertFails(set(ref(asAgent(AGENT, BOARD), path), { notifiedAt: 0 }));
    await assertFails(get(ref(dbOf(ADMIN), live.silenceRoot())));
    await assertFails(set(ref(dbOf(ADMIN), path), { notifiedAt: 0 }));
  });

  it('statusKey names the stream: the ticket id, or “_” for an agent-level beat', async () => {
    await assertSucceeds(
      get(ref(asAgent(AGENT, BOARD), `${live.agentStatus(BOARD, AGENT)}/${statusKey(TICKET)}`)),
    );
  });
});

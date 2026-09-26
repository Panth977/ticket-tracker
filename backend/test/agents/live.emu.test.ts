/**
 * THE LIVE TREE (docs/plan/agents.html §W) — what phase 15 moved out of
 * Firestore and what it must cost.
 *
 *   heartbeat        ONE ~100-byte RTDB node, no Firestore document at all
 *   rev/{boardId}    bumped EXACTLY ONCE per board-changing command
 *   agents/{id}/wake bumped when something lands in an agent's inbox
 *   silence          derived from `at`; the sweep reads the RTDB, not Firestore
 *
 * This replaces test/phase3/heartbeat.emu.test.ts, which asserted the beat as a
 * Firestore document; every case it covered is here, against the new storage.
 */
import { describe, expect, it } from 'vitest';
import {
  agentStatusId,
  deriveAgentHealth,
  HEARTBEAT_SILENCE_NOTIFY_MS,
  live,
  paths,
  type InboxItem,
} from '@tm/shared';
import { agentSilenceSweep, LIVE_STATUS_TTL_MS } from '../../src/agents/silence.js';
import { bumpsBoardRev } from '../../src/platform/rtdbPaths.js';
import { db, rtdbAdmin } from '../../src/runtime/firebase.js';
import { call, setupEmulators } from '../harness/index.js';
import { listDocs, people, seedBoard, spyPorts } from '../tickets/helpers.js';
import {
  asAgent,
  liveRev,
  liveSilence,
  liveStatus,
  liveStatusNode,
  liveWake,
  makeAgent,
  type TestAgent,
} from './helpers.js';

setupEmulators();

const MIN = 60_000;

/** A board, an agent on it and one ticket — the smallest live scene. */
async function scene(): Promise<{
  boardId: string;
  ticketId: string;
  agent: TestAgent;
  ashaUid: string;
  asha: Awaited<ReturnType<typeof people>>['asha'];
}> {
  const { asha } = await people('asha');
  const b = await seedBoard({ admin: asha });
  const agent = await makeAgent(asha, { boardId: b.id, role: 'editor' });
  const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'Build it' });
  return { boardId: b.id, ticketId, agent, ashaUid: asha.uid, asha };
}

describe('agentHeartbeat → the RTDB', () => {
  it('writes ONE small node and no Firestore document at all', async () => {
    spyPorts();
    const sc = await scene();
    const t0 = Date.now();

    const res = await asAgent(
      sc.agent,
      'agentHeartbeat',
      {
        boardId: sc.boardId,
        ticketId: sc.ticketId,
        state: 'working',
        message: 'Running tests (3/12)',
        progress: 0.25,
      },
      { now: t0 },
    );
    // The id in the answer is unchanged: REST, MCP and the SDK still speak it.
    expect(res.statusId).toBe(agentStatusId(sc.agent.id, sc.ticketId));

    expect(await liveStatus(sc.boardId, sc.agent.id, sc.ticketId)).toMatchObject({
      agentId: sc.agent.id,
      ticketId: sc.ticketId,
      state: 'working',
      message: 'Running tests (3/12)',
      progress: 0.25,
      lastBeatAt: t0,
      startedAt: t0,
      endedAt: null,
    });

    // THE POINT OF §W: the Firestore document is gone, not merely smaller.
    const fsDoc = await db().doc(paths.agentStatusDoc(sc.boardId, res.statusId)).get();
    expect(fsDoc.exists).toBe(false);
    expect((await db().collection(paths.agentStatuses(sc.boardId)).get()).empty).toBe(true);

    // And a beat is ~100 bytes: only the fields §W names are stored, and a
    // beat with nothing to say stores no empty children either.
    const node = (await liveStatusNode(sc.boardId, sc.agent.id, sc.ticketId))!;
    expect(Object.keys(node).sort()).toEqual(
      ['at', 'message', 'progress', 'startedAt', 'state', 'ticketId'].sort(),
    );
    expect(JSON.stringify(node).length).toBeLessThan(200);
  });

  it('keeps one run alive, ends it, starts a new one — and never writes the ticket', async () => {
    spyPorts();
    const sc = await scene();
    const t0 = Date.now();
    const before = (await db().doc(paths.ticket(sc.boardId, sc.ticketId)).get()).data()!;
    const beat = (now: number, state: 'working' | 'idle' | 'done' | 'error', message?: string) =>
      asAgent(
        sc.agent,
        'agentHeartbeat',
        {
          boardId: sc.boardId,
          ticketId: sc.ticketId,
          state,
          ...(message ? { message } : {}),
        },
        { now },
      );
    const status = () => liveStatus(sc.boardId, sc.agent.id, sc.ticketId);

    await beat(t0, 'working', 'Running tests');
    await beat(t0 + MIN, 'working');
    let s = (await status())!;
    // The same run: startedAt is untouched, and the message it no longer sends
    // is cleared rather than remembered.
    expect(s).toMatchObject({ startedAt: t0, lastBeatAt: t0 + MIN, message: null });
    // §L3, with no write at all: 75 seconds of quiet reads as stale.
    expect(deriveAgentHealth(s, t0 + MIN + 10_000)).toBe('working');
    expect(deriveAgentHealth(s, t0 + MIN + 80_000)).toBe('stale');

    await beat(t0 + 2 * MIN, 'done');
    s = (await status())!;
    expect(s).toMatchObject({ state: 'done', startedAt: t0, endedAt: t0 + 2 * MIN });
    expect(deriveAgentHealth(s, t0 + 99 * MIN)).toBe('done');

    // Work starting again resets the run and clears endedAt.
    await beat(t0 + 10 * MIN, 'working');
    expect(await status()).toMatchObject({ startedAt: t0 + 10 * MIN, endedAt: null });

    const after = (await db().doc(paths.ticket(sc.boardId, sc.ticketId)).get()).data()!;
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.lastActivityAt).toBe(before.lastActivityAt);
  });

  it('an agent-level beat lives under “_” and names no ticket', async () => {
    spyPorts();
    const sc = await scene();
    const { statusId } = await asAgent(sc.agent, 'agentHeartbeat', {
      boardId: sc.boardId,
      state: 'idle',
      message: 'waiting for an answer',
    });
    expect(statusId).toBe(agentStatusId(sc.agent.id, null));
    expect(await liveStatus(sc.boardId, sc.agent.id, null)).toMatchObject({
      ticketId: null,
      state: 'idle',
    });
    // Its own stream: a ticket beat and an agent-level beat never overwrite
    // each other.
    expect(await liveStatus(sc.boardId, sc.agent.id, sc.ticketId)).toBeNull();
    expect(
      (await rtdbAdmin().ref(live.agentStatus(sc.boardId, sc.agent.id)).get()).val(),
    ).toHaveProperty('_');
  });

  it('is still scope-checked: only the agent itself or a board admin may beat', async () => {
    spyPorts();
    const { asha, priya } = await people('asha', 'priya');
    const b = await seedBoard({ admin: asha, editors: [priya] });
    const agent = await makeAgent(asha, { boardId: b.id, role: 'editor' });

    await expect(
      call(priya, 'agentHeartbeat', { boardId: b.id, agentId: agent.id, state: 'error' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // The board admin may — this is how the owner clears a stuck run.
    await call(asha, 'agentHeartbeat', {
      boardId: b.id,
      agentId: agent.id,
      state: 'error',
      message: 'killed by hand',
    });
    expect(await liveStatus(b.id, agent.id, null)).toMatchObject({ state: 'error' });
    // A person with no agentId has nothing to beat for.
    await expect(
      call(asha, 'agentHeartbeat', { boardId: b.id, state: 'idle' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    // An agent that is not on this board has no status here, and a refused
    // beat writes NOTHING.
    await expect(
      call(asha, 'agentHeartbeat', {
        boardId: b.id,
        agentId: 'ag_0000000000000000',
        state: 'idle',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await liveStatus(b.id, 'ag_0000000000000000', null)).toBeNull();
    await expect(
      call(asha, 'agentHeartbeat', {
        boardId: b.id,
        agentId: agent.id,
        ticketId: 'nope',
        state: 'working',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('rev/{boardId} — the board revision', () => {
  it('a command bumps it EXACTLY ONCE', async () => {
    spyPorts();
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });

    const before = await liveRev(b.id);
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'One' });
    const first = (await liveRev(b.id))!;
    expect(first.at).toBeGreaterThan(before?.at ?? 0);
    expect(first.by).toBe(asha.uid);

    // rev is a REVISION, not a log: a second command overwrites it, so the
    // node stays one small object however busy the board is.
    await call(asha, 'ticketUpdate', { boardId: b.id, ticketId, patch: { title: 'Two' } });
    const second = (await liveRev(b.id))!;
    expect(second.at).toBeGreaterThanOrEqual(first.at);
    expect(Object.keys(second).sort()).toEqual(['at', 'by']);

    // A REPLAYED (idempotent) request changed nothing, so it announces nothing.
    const clientId = 'idem-rev-1';
    await call(asha, 'ticketCreate', { boardId: b.id, title: 'Three', clientId });
    const afterFirstTry = (await liveRev(b.id))!;
    await call(asha, 'ticketCreate', { boardId: b.id, title: 'Three', clientId });
    expect((await liveRev(b.id))!.at).toBe(afterFirstTry.at);
  });

  it('a heartbeat does NOT bump it — that is the whole point', async () => {
    spyPorts();
    const sc = await scene();
    const before = await liveRev(sc.boardId);
    await call(sc.asha, 'agentHeartbeat', {
      boardId: sc.boardId,
      agentId: sc.agent.id,
      state: 'working',
    });
    expect((await liveRev(sc.boardId))?.at ?? null).toBe(before?.at ?? null);
    expect(bumpsBoardRev('agentHeartbeat')).toBe(false);
    expect(bumpsBoardRev('ticketCreate')).toBe(true);
  });

  it('a command that names no board announces nothing', async () => {
    spyPorts();
    const { asha } = await people('asha');
    // agentCreate has no boardId: there is no board to tell.
    const revBefore = (await rtdbAdmin().ref(live.revRoot()).get()).val();
    await makeAgent(asha, {});
    expect((await rtdbAdmin().ref(live.revRoot()).get()).val()).toEqual(revBefore);
  });
});

describe('agents/{agentId}/wake', () => {
  it('is bumped when something lands in the agent\u2019s inbox', async () => {
    // NO spyPorts here: the real notify() is what writes the agent's inbox,
    // and the wake rides on that write.
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const agent = await makeAgent(asha, { boardId: b.id, role: 'editor' });
    expect(await liveWake(agent.id)).toBeNull();

    // Assigning a ticket to the agent writes an agentInbox event.
    await call(asha, 'ticketCreate', {
      boardId: b.id,
      title: 'Build it',
      assigneeUids: [agent.id],
    });
    const wake = await liveWake(agent.id);
    expect(wake).toMatchObject({ boardId: b.id });
    expect(wake!.at).toBeGreaterThan(0);
    // A wake is a HINT, not the event: only 'at' and the board hint travel, so
    // the node stays a few dozen bytes however busy the agent is.
    expect(Object.keys(wake!).sort()).toEqual(['at', 'boardId']);
    // The event itself is still in Firestore, where the cursor works.
    expect((await db().collection(paths.agentEvents(agent.id)).get()).size).toBe(1);

    // A second event moves it rather than appending to it.
    const { ticketId } = await call(asha, 'ticketCreate', {
      boardId: b.id,
      title: 'And again',
      assigneeUids: [agent.id],
    });
    expect(ticketId).toBeTruthy();
    const again = (await liveWake(agent.id))!;
    expect(again.at).toBeGreaterThanOrEqual(wake!.at);
    expect(Object.keys(again).sort()).toEqual(['at', 'boardId']);
  });
});

describe('agentSilenceSweep — off Firestore, onto the RTDB', () => {
  it('tells the owner once per silence, from the RTDB', async () => {
    spyPorts();
    const sc = await scene();
    const t0 = Date.now();
    await asAgent(
      sc.agent,
      'agentHeartbeat',
      { boardId: sc.boardId, ticketId: sc.ticketId, state: 'working', message: 'Running tests' },
      { now: t0 },
    );
    // The sweep reads the whole tree, which other test files share: only this
    // agent's notices are ours.
    const mine = async (now: number) =>
      (await agentSilenceSweep(now)).notices.filter((n) => n.agentId === sc.agent.id);
    const silenceRows = async () =>
      (await listDocs<InboxItem>(paths.inbox(sc.ashaUid))).filter((r) =>
        r.groupKey.startsWith('agentSilence:'),
      );

    // Four minutes of quiet is not enough; six is.
    expect(await mine(t0 + 4 * MIN)).toHaveLength(0);
    expect(await silenceRows()).toHaveLength(0);
    expect(await mine(t0 + 6 * MIN)).toMatchObject([
      { agentId: sc.agent.id, ownerUid: sc.ashaUid },
    ]);
    const rows = await silenceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toContain('no signal for 6 min');
    // The mark is in the CLOSED subtree, not on the beat.
    expect(await liveSilence(sc.boardId, sc.agent.id, sc.ticketId)).toEqual({
      notifiedAt: t0 + 6 * MIN,
    });
    const node = (await liveStatusNode(sc.boardId, sc.agent.id, sc.ticketId))!;
    expect(node).not.toHaveProperty('notifiedAt');
    expect(node).not.toHaveProperty('silenceNotifiedAt');

    // Still quiet → the owner is not told again.
    expect(await mine(t0 + 9 * MIN)).toHaveLength(0);
    expect(await silenceRows()).toHaveLength(1);

    // A beat, then silence again → a NEW silence, so a new notice.
    await asAgent(
      sc.agent,
      'agentHeartbeat',
      { boardId: sc.boardId, ticketId: sc.ticketId, state: 'working' },
      { now: t0 + 10 * MIN },
    );
    expect(await mine(t0 + 12 * MIN)).toHaveLength(0);
    expect(await mine(t0 + 10 * MIN + HEARTBEAT_SILENCE_NOTIFY_MS + 1000)).toHaveLength(1);

    // A finished run is never 'silent'.
    await asAgent(
      sc.agent,
      'agentHeartbeat',
      { boardId: sc.boardId, ticketId: sc.ticketId, state: 'done' },
      { now: t0 + 20 * MIN },
    );
    expect(await mine(t0 + 99 * MIN)).toHaveLength(0);
  });

  it('says nothing for an archived agent', async () => {
    spyPorts();
    const sc = await scene();
    const t0 = Date.now();
    await asAgent(
      sc.agent,
      'agentHeartbeat',
      { boardId: sc.boardId, state: 'working' },
      { now: t0 },
    );
    await call(sc.asha, 'agentArchive', { agentId: sc.agent.id });
    const r = await agentSilenceSweep(t0 + 6 * MIN);
    expect(r.notices.filter((n) => n.agentId === sc.agent.id)).toHaveLength(0);
    expect(
      (await listDocs<InboxItem>(paths.inbox(sc.ashaUid))).filter((row) =>
        row.groupKey.includes(sc.agent.id),
      ),
    ).toHaveLength(0);
  });

  it('prunes beat streams nobody has touched for a week', async () => {
    spyPorts();
    const sc = await scene();
    const t0 = Date.now();
    await asAgent(
      sc.agent,
      'agentHeartbeat',
      { boardId: sc.boardId, ticketId: sc.ticketId, state: 'done' },
      { now: t0 },
    );
    expect(await liveStatus(sc.boardId, sc.agent.id, sc.ticketId)).not.toBeNull();
    // A pass a day later keeps it; one past the TTL drops it.
    await agentSilenceSweep(t0 + 24 * 60 * MIN);
    expect(await liveStatus(sc.boardId, sc.agent.id, sc.ticketId)).not.toBeNull();
    const r = await agentSilenceSweep(t0 + LIVE_STATUS_TTL_MS + MIN);
    expect(r.pruned).toBeGreaterThan(0);
    expect(await liveStatus(sc.boardId, sc.agent.id, sc.ticketId)).toBeNull();
  });
});

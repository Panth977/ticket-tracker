/**
 * Phase 3 §L3 / phase 15 §W — 'STOPPED REPORTING', WITH ALMOST NO SWEEP.
 *
 * 'state working, last beat > 75 s ago → 🔴 "No signal for 3 min". The
 * orchestrator may have died. A scheduled sweep notifies the agent's owner
 * after 5 minutes of silence (once per silence).'
 *
 * WHAT THE SERVER IS STILL FOR. Staleness itself needs NO server at all: it is
 * `now - at > 75 s`, computed by deriveAgentHealth wherever the beat is read,
 * so a card goes red on its own with no write and no query (§W). The only
 * thing that genuinely needs a server is RAISING THE NOTIFICATION — telling a
 * person, once, that the agent they own went quiet, because nobody may be
 * looking at the board at all. That is all this does, every three minutes.
 *
 * WHAT IT READS. One RTDB read of the whole `status` tree instead of a
 * Firestore collection-group query over agentStatus. Fifty boards of live
 * agents is a few kilobytes of bandwidth and zero billable operations; the
 * query it replaces cost one document read per candidate, every minute,
 * forever. The 'already told them' marks come from the closed `silence`
 * subtree in the same shape, joined here — see platform/rtdbPaths.ts for why
 * they are not inside the beat.
 *
 *   read status/ + silence/ → agentSilenceDue() (shared, so the UI and this
 *     agree) → one in-app row in the OWNER's inbox → silence mark = now, which
 *     is what makes it once per silence: the next beat moves `at` past the
 *     mark and re-arms it.
 *
 * The owner is a person, so this goes through the same users/{uid}/inbox the
 * notify router writes. There is no NotifyEvent for 'your agent went quiet'
 * (a REQUEST is filed for p3-contracts); the row is filed as 'updated' with
 * its own groupKey and an explicit summary, so it never collapses into a
 * ticket's update row.
 */
import {
  agentSilenceDue,
  agentStatusId,
  HEARTBEAT_SILENCE_NOTIFY_MS,
  paths,
  type Agent,
  type Ticket,
} from '@tm/shared';
import { db } from '../runtime/firebase.js';
import { writeInbox } from '../notify/router.js';
import {
  markSilenceNotified,
  pruneLive,
  readAllStatuses,
  readSilenceMarks,
  silenceMarkKey,
} from '../platform/rtdbPaths.js';

export interface SilenceNotice {
  boardId: string;
  agentId: string;
  ticketId: string | null;
  ownerUid: string;
  silentForMs: number;
  inboxId: string;
}

export interface SilenceSweepResult {
  checked: number;
  notices: SilenceNotice[];
  /** Live nodes the pass removed (see pruneStale). */
  pruned: number;
}

/**
 * HOW LONG A BEAT IS WORTH KEEPING. 'Finished · 10:42' is worth showing for a
 * while; a beat from last month is not, and the RTDB bills for stored bytes as
 * well as for traffic. A stream nobody has touched in a week is dropped, along
 * with any silence mark left behind by a stream that no longer exists — the
 * marks are derived data, so they can always be thrown away.
 */
export const LIVE_STATUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 'No signal for 6 min' — the same words §L3 puts on the ticket header. */
export function silenceSummary(
  name: string,
  silentForMs: number,
  ticketKey: string | null,
): string {
  const mins = Math.max(1, Math.round(silentForMs / 60_000));
  const where = ticketKey ? ` on ${ticketKey}` : '';
  return `${name} stopped reporting${where} — no signal for ${mins} min`;
}

/**
 * One pass. `limit` caps the beats a single run looks at — the read is one
 * cheap RTDB fetch either way, so the cap is about how many INBOX WRITES a run
 * may do, not about the read; the schedule comes round again in three minutes.
 */
export async function agentSilenceSweep(now: number, limit = 200): Promise<SilenceSweepResult> {
  const [rows, marks] = await Promise.all([readAllStatuses(), readSilenceMarks()]);
  // Only a 'working' beat old enough to matter can possibly be due; the shared
  // agentSilenceDue() then applies the once-per-silence rule.
  const candidates = rows
    .filter(
      ({ status }) =>
        status.state === 'working' && status.lastBeatAt <= now - HEARTBEAT_SILENCE_NOTIFY_MS,
    )
    .sort((a, b) => a.status.lastBeatAt - b.status.lastBeatAt)
    .slice(0, limit);

  const out: SilenceSweepResult = { checked: candidates.length, notices: [], pruned: 0 };
  // agents/{agentId} is read once per agent, not once per beat stream.
  const owners = new Map<string, Agent | undefined>();

  for (const { boardId, status } of candidates) {
    const silenceNotifiedAt =
      marks.get(silenceMarkKey(boardId, status.agentId, status.ticketId)) ?? null;
    if (!agentSilenceDue({ ...status, silenceNotifiedAt }, now)) continue;

    if (!owners.has(status.agentId)) {
      const a = await db().doc(paths.agent(status.agentId)).get();
      owners.set(status.agentId, a.exists ? (a.data() as Agent) : undefined);
    }
    const agent = owners.get(status.agentId);
    // An archived agent is not running: nobody needs telling.
    if (!agent || agent.archivedAt !== null) continue;

    let ticketKey: string | null = null;
    if (status.ticketId) {
      const t = await db().doc(paths.ticket(boardId, status.ticketId)).get();
      ticketKey = (t.data() as Ticket | undefined)?.key ?? null;
    }
    const silentForMs = now - status.lastBeatAt;
    // The same group key the Firestore-era sweep used, so a row raised before
    // §W and one raised after it still collapse together.
    const groupKey = `agentSilence:${boardId}:${agentStatusId(status.agentId, status.ticketId)}`;
    const inboxId = await writeInbox(agent.ownerUid, groupKey, {
      event: 'agentSilence',
      boardId,
      ticketId: status.ticketId,
      ticketKey,
      ticketTitle: null,
      inviteId: null,
      // The system noticed, not a person.
      actor: null,
      via: 'system',
      summary: silenceSummary(agent.name, silentForMs, ticketKey),
      groupKey,
      createdAt: now,
    });
    await markSilenceNotified(boardId, status.agentId, status.ticketId, now);
    out.notices.push({
      boardId,
      agentId: status.agentId,
      ticketId: status.ticketId,
      ownerUid: agent.ownerUid,
      silentForMs,
      inboxId,
    });
  }

  out.pruned = await pruneStale(rows, marks, now);
  return out;
}

/**
 * Keep the live tree bounded, in ONE multi-path removal (or none at all when
 * there is nothing to drop): beat streams nobody has touched for a week, and
 * silence marks whose stream is gone. Nothing here is a source of truth.
 */
async function pruneStale(
  rows: {
    boardId: string;
    status: { agentId: string; ticketId: string | null; lastBeatAt: number };
  }[],
  marks: Map<string, number>,
  now: number,
): Promise<number> {
  const alive = new Set(
    rows.map(({ boardId, status }) => silenceMarkKey(boardId, status.agentId, status.ticketId)),
  );
  const stale = rows
    .filter(({ status }) => now - status.lastBeatAt > LIVE_STATUS_TTL_MS)
    .map(({ boardId, status }) => ({
      boardId,
      agentId: status.agentId,
      ticketId: status.ticketId,
    }));
  for (const s of stale) alive.delete(silenceMarkKey(s.boardId, s.agentId, s.ticketId));
  const orphanMarks = [...marks.keys()].filter((k) => !alive.has(k));
  return pruneLive(stale, orphanMarks);
}

/**
 * THE LIVE TREE — liveness in the Realtime Database (docs/plan/agents.html §W).
 *
 * Firestore bills OPERATIONS; the RTDB bills BANDWIDTH. Anything that changes
 * once a minute forever and is read by every open tab therefore belongs here:
 * a heartbeat is ~100 bytes of traffic instead of a Firestore transaction plus
 * one document read in every client that is watching the board.
 *
 *   status/{boardId}/{agentId}/{ticketId|'_'}   what an agent says it is doing
 *   rev/{boardId}                               'something on this board changed'
 *   agents/{agentId}/wake                       'something is in your inbox'
 *   silence/{boardId}/{agentId}/{ticketId|'_'}  the sweep's own bookkeeping (server-only)
 *
 * plus the tree that was already here (presence, typing, boardReaders, rate —
 * see `rtdb` in paths.ts). The names are split so this module can be imported
 * on its own ('@tm/shared/rtdb') by a client that wants nothing else.
 *
 * WHY A REVISION AND NOT A FEED. `rev/{boardId}` is not a log: it is one tiny
 * node the command layer overwrites after any write that could change what a
 * board's tickets look like. A watcher sees it move and then asks Firestore
 * for the DELTA (updatedAt > lastSynced). One RTDB write per command, one
 * cheap Firestore query per actual change, and an idle board costs nothing.
 *
 * NULLS DO NOT EXIST IN THE RTDB. Writing null deletes the child, so every
 * optional field here reads back as `undefined`; `toAgentStatus()` puts the
 * nulls back so the rest of the system keeps the one AgentStatus shape.
 *
 * WHO MAY READ WHAT (backend/database.rules.json — RTDB rules cannot read
 * Firestore, so they go by mirrors and claims):
 *
 *   a PERSON is on a board when boardReaders/{boardId}/{uid} === true, the
 *     mirror boardShared.syncReaders keeps; that lets them read
 *     status/{boardId} and rev/{boardId} and nothing above them.
 *   an AGENT presents a BOARD-SCOPED credential: a token whose `board` claim
 *     is the board it was issued for and whose uid is the agent id. It may
 *     read that board's status and rev, and write ONLY
 *     status/{board}/{its own id}/… — never another agent's, never another
 *     board's. (The normal path is still the heartbeat COMMAND through the
 *     API, which is scope-checked; the direct write exists so an orchestrator
 *     that already holds a stream does not need a round trip through a
 *     function to say it is alive.)
 *   agents/{agentId}/wake is readable by that agent alone, and written only
 *     by the server.
 *   silence/ is closed to every client: it is the sweep's own bookkeeping.
 */
import { z } from 'zod';
import {
  AGENT_STATUS_MESSAGE_MAX,
  AGENT_STATUS_NO_TICKET,
  AgentStateSchema,
  type AgentStatus,
} from './schema/agentStatus.js';
import { AgentIdSchema, MillisSchema, PrincipalIdSchema, TicketIdSchema } from './types/index.js';

/**
 * RTDB keys may not contain '.', '$', '#', '[', ']', '/' or any ASCII control
 * character. An id that would change the shape of a path (or be silently
 * rejected by the database) is a programming error, not an empty read.
 */
const RTDB_BAD_KEY = /[.$#[\]/]/;
const isControl = (id: string): boolean => {
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
};
function key(id: string): string {
  if (!id || RTDB_BAD_KEY.test(id) || isControl(id)) {
    throw new Error(`Invalid RTDB key: ${JSON.stringify(id)}`);
  }
  return id;
}

/** The child under an agent that one beat stream lives in ('_' = no ticket). */
export const statusKey = (ticketId: string | null): string =>
  ticketId === null ? AGENT_STATUS_NO_TICKET : key(ticketId);

/** The inverse of statusKey(). */
export const ticketIdOfStatusKey = (k: string): string | null =>
  k === AGENT_STATUS_NO_TICKET ? null : k;

/** Realtime Database locations for liveness (§W). Everything else is `rtdb` in paths.ts. */
export const live = {
  /** The whole status tree — read by the silence sweep, never by a client. */
  statusRoot: () => 'status',
  /** status/{boardId} — what every agent on this board is doing. */
  boardStatus: (boardId: string) => `status/${key(boardId)}`,
  /** status/{boardId}/{agentId} — one agent's beat streams on this board. */
  agentStatus: (boardId: string, agentId: string) => `status/${key(boardId)}/${key(agentId)}`,
  /** status/{boardId}/{agentId}/{ticketId|'_'} — ONE beat stream. */
  status: (boardId: string, agentId: string, ticketId: string | null) =>
    `status/${key(boardId)}/${key(agentId)}/${statusKey(ticketId)}`,

  /** rev/{boardId} — bumped by the command layer on every board-changing write. */
  revRoot: () => 'rev',
  rev: (boardId: string) => `rev/${key(boardId)}`,

  /** agents/{agentId}/wake — bumped when something lands in that agent's inbox. */
  agentRoot: (agentId: string) => `agents/${key(agentId)}`,
  wake: (agentId: string) => `agents/${key(agentId)}/wake`,

  /** silence/{boardId}/{agentId}/{ticketId|'_'} — server-only sweep bookkeeping. */
  silenceRoot: () => 'silence',
  boardSilence: (boardId: string) => `silence/${key(boardId)}`,
  silence: (boardId: string, agentId: string, ticketId: string | null) =>
    `silence/${key(boardId)}/${key(agentId)}/${statusKey(ticketId)}`,
} as const;

/**
 * status/{boardId}/{agentId}/{ticketId|'_'} — what §W calls the heartbeat.
 * `at` is the beat time; STALENESS IS DERIVED FROM IT WHEREVER IT IS READ
 * (deriveAgentHealth), so nothing has to write 'this agent went quiet'.
 */
export const LiveStatusSchema = z.object({
  state: AgentStateSchema,
  /** 'Running tests (3/12)'. Absent, not null: the RTDB deletes null children. */
  message: z.string().max(AGENT_STATUS_MESSAGE_MAX).nullish(),
  /** 0–1. */
  progress: z.number().min(0).max(1).nullish(),
  /** This beat. */
  at: MillisSchema,
  /** The first beat of THIS run (reset when work restarts after done / error). */
  startedAt: MillisSchema,
  /** Set by a 'done' or 'error' beat, cleared when work resumes. */
  endedAt: MillisSchema.nullish(),
  /** Repeated inside the node so a reader that took one child still knows. */
  ticketId: TicketIdSchema.nullish(),
});
export type LiveStatus = z.infer<typeof LiveStatusSchema>;

/** rev/{boardId} — 'something changed here'. `by` is the principal that caused it. */
export const BoardRevSchema = z.object({
  at: MillisSchema,
  by: PrincipalIdSchema.nullish(),
});
export type BoardRev = z.infer<typeof BoardRevSchema>;

/** agents/{agentId}/wake — 'there is something in your inbox'. */
export const AgentWakeSchema = z.object({
  at: MillisSchema,
  /** The board the event is about, when it is about one (a hint, not a filter). */
  boardId: z.string().nullish(),
});
export type AgentWake = z.infer<typeof AgentWakeSchema>;

/** silence/{boardId}/{agentId}/{key} — when the owner was last told (§L3). */
export const SilenceMarkSchema = z.object({ notifiedAt: MillisSchema });
export type SilenceMark = z.infer<typeof SilenceMarkSchema>;

/**
 * A live node → the AgentStatus shape the whole system already speaks, so
 * toPublicAgentStatus(), deriveAgentHealth() and every card keep working
 * without knowing where the beat is stored.
 */
export function toAgentStatus(
  agentId: string,
  ticketId: string | null,
  node: LiveStatus,
): AgentStatus {
  return {
    agentId,
    ticketId: node.ticketId ?? ticketId,
    state: node.state,
    message: node.message ?? null,
    progress: node.progress ?? null,
    lastBeatAt: node.at,
    startedAt: node.startedAt,
    endedAt: node.endedAt ?? null,
  };
}

/** One board's status tree → AgentStatus rows. Anything malformed is skipped. */
export function statusesOfBoard(
  tree: Record<string, Record<string, unknown>> | null | undefined,
): (AgentStatus & { key: string })[] {
  const out: (AgentStatus & { key: string })[] = [];
  if (!tree) return out;
  for (const [agentId, streams] of Object.entries(tree)) {
    if (!streams || typeof streams !== 'object') continue;
    if (!AgentIdSchema.safeParse(agentId).success) continue;
    for (const [k, raw] of Object.entries(streams)) {
      const parsed = LiveStatusSchema.safeParse(raw);
      if (!parsed.success) continue;
      out.push({ key: k, ...toAgentStatus(agentId, ticketIdOfStatusKey(k), parsed.data) });
    }
  }
  return out;
}

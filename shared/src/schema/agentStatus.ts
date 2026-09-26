/**
 * Phase 3 — HEARTBEAT: IS THE AGENT ALIVE? (docs/plan/agents.html §L3)
 *
 * The orchestrator beats every minute while it works, and once more when the
 * work ends. A beat never touches the ticket, so a beat a minute does not
 * retrigger search indexing or re-render every listener.
 *
 * WHERE IT LIVES (§W, phase 15). Beats used to be a Firestore document per
 * stream, boards/{b}/agentStatus/{agentId}__{ticketId|'_'}: 1,440 transactions
 * per agent per day plus one document read in every open tab. They now live in
 * the Realtime Database, which bills bandwidth rather than operations, at
 * status/{boardId}/{agentId}/{ticketId|'_'} — see shared/src/rtdb.ts.
 *
 * THIS FILE IS STILL THE SHAPE. AgentStatus is what the RTDB node is READ AS
 * (toAgentStatus) and what every card, drawer, /v1/heartbeat answer and the
 * Agents page speak, so the storage move changed nothing above it. The id
 * helpers stay too: `agentId__ticketId` is the id the REST and MCP contracts
 * already return.
 */
import { z } from 'zod';
import { AgentIdSchema, MillisSchema, TicketIdSchema } from '../types/index.js';

/** What the orchestrator says it is doing. */
export const AGENT_STATES = ['working', 'idle', 'done', 'error'] as const;
export const AgentStateSchema = z.enum(AGENT_STATES);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const AGENT_STATUS_MESSAGE_MAX = 200;

/**
 * One beat stream, as everything above the database sees it. Stored as an RTDB
 * node (LiveStatusSchema in rtdb.ts, where `lastBeatAt` is simply `at`).
 */
export const AgentStatusSchema = z.object({
  agentId: AgentIdSchema,
  /** null = an agent-level beat, about no ticket in particular (the Agents page). */
  ticketId: TicketIdSchema.nullable(),
  state: AgentStateSchema,
  /** 'Running tests (3/12)'. */
  message: z.string().max(AGENT_STATUS_MESSAGE_MAX).nullable(),
  /** 0–1. */
  progress: z.number().min(0).max(1).nullable(),
  lastBeatAt: MillisSchema,
  /** The first beat of this run (reset when a 'working' beat follows a done / error one). */
  startedAt: MillisSchema,
  /** Set by a 'done' or 'error' beat; cleared when work starts again. */
  endedAt: MillisSchema.nullable(),
  /**
   * Server-only bookkeeping for agentSilenceSweep: when the owner was last
   * told this agent went quiet, so they are told once per silence (§L3). NOT
   * part of the beat itself — it is kept in its own closed RTDB subtree,
   * silence/{boardId}/{agentId}/{ticketId|'_'}, and the sweep joins it on
   * (§W: the status node stays ~100 bytes and a client cannot forge this).
   */
  silenceNotifiedAt: MillisSchema.nullable().optional(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type AgentStatusWithId = AgentStatus & { id: string; boardId: string };

/** Doc id for an agent-level beat (no ticket). */
export const AGENT_STATUS_NO_TICKET = '_';
/** The separator in the doc id; ids must not contain it. */
export const AGENT_STATUS_SEP = '__';

/** boards/{b}/agentStatus/{agentId}__{ticketId|'_'} — the document id for one beat stream. */
export function agentStatusId(agentId: string, ticketId: string | null): string {
  const t = ticketId ?? AGENT_STATUS_NO_TICKET;
  if (agentId.includes(AGENT_STATUS_SEP) || t.includes(AGENT_STATUS_SEP)) {
    throw new Error(`agentStatusId: ids may not contain '${AGENT_STATUS_SEP}'`);
  }
  return `${agentId}${AGENT_STATUS_SEP}${t}`;
}

/** The inverse of agentStatusId(); null when the id is not one. */
export function parseAgentStatusId(
  id: string,
): { agentId: string; ticketId: string | null } | null {
  const i = id.indexOf(AGENT_STATUS_SEP);
  if (i <= 0) return null;
  const agentId = id.slice(0, i);
  const rest = id.slice(i + AGENT_STATUS_SEP.length);
  if (!rest || !AgentIdSchema.safeParse(agentId).success) return null;
  return { agentId, ticketId: rest === AGENT_STATUS_NO_TICKET ? null : rest };
}

/**
 * THE 75-SECOND RULE (§L3). The orchestrator beats every 60 s; one missed beat
 * plus a little slack is silence, so a 'working' status whose last beat is
 * older than this reads as 🔴 'No signal for 3 min'.
 */
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const HEARTBEAT_STALE_MS = 75_000;
/** agentSilenceSweep tells the agent's owner after five minutes of silence, once per silence. */
export const HEARTBEAT_SILENCE_NOTIFY_MS = 5 * 60_000;

/**
 * What the UI shows, computed from the state and the time since the last beat:
 *   working  🟢 pulsing dot + 'Working · Running tests (3/12)'
 *   stale    🔴 'No signal for 3 min' — the orchestrator may have died
 *   idle     🟡 'Idle · waiting for an answer'
 *   done     ⚪ 'Finished · 10:42'
 *   error    🔴 'Stopped with an error' + the message
 *   none     nothing at all (no status document yet)
 */
export const AGENT_HEALTHS = ['working', 'stale', 'idle', 'done', 'error', 'none'] as const;
export const AgentHealthSchema = z.enum(AGENT_HEALTHS);
export type AgentHealth = z.infer<typeof AgentHealthSchema>;

/**
 * deriveAgentHealth(status, now) — the ONE place the dot's colour is decided,
 * so a card, the drawer header, People & roles and the Agents page never
 * disagree. Only 'working' can go stale: an idle / done / error status is a
 * statement that stays true until the next beat.
 */
export function deriveAgentHealth(
  status: Pick<AgentStatus, 'state' | 'lastBeatAt'> | null | undefined,
  now: number,
  staleAfterMs: number = HEARTBEAT_STALE_MS,
): AgentHealth {
  if (!status) return 'none';
  if (status.state !== 'working') return status.state;
  return now - status.lastBeatAt > staleAfterMs ? 'stale' : 'working';
}

/** Silence long enough for the sweep to tell the owner (and not told yet). */
export function agentSilenceDue(
  status: Pick<AgentStatus, 'state' | 'lastBeatAt' | 'silenceNotifiedAt'>,
  now: number,
): boolean {
  if (status.state !== 'working') return false;
  if (now - status.lastBeatAt < HEARTBEAT_SILENCE_NOTIFY_MS) return false;
  // Told once per silence: a beat since the notice re-arms it.
  return (status.silenceNotifiedAt ?? 0) <= status.lastBeatAt;
}

/** Is anything running on this ticket right now? ('Finished' and 'stale' are not.) */
export const agentIsLive = (health: AgentHealth): boolean =>
  health === 'working' || health === 'idle';

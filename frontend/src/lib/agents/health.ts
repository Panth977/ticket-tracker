/**
 * Phase 3 — IS THE AGENT ALIVE? (docs/plan/agents.html §L3)
 *
 * The orchestrator beats every minute into
 *   boards/{b}/agentStatus/{agentId}__{ticketId | '_'}
 * and THE BOARD LISTENS TO THAT COLLECTION ONCE — every card, the drawer
 * header, People & roles and the Agents page read from the same snapshot
 * (see ./agentStatus: `queryStore` shares and ref-counts by spec, so asking
 * for the same board from ten places is still one onSnapshot).
 *
 * What is SHOWN is derived, never stored: `deriveAgentHealth` (shared) turns
 * the state plus the time since the last beat into one of
 *   working · stale · idle · done · error · none
 * so a 'working' status goes red by itself when the beats stop. Derived means
 * the clock has to move: `healthClock` ticks every 15 s, which is a quarter of
 * the beat interval — the longest a dot can be wrong is 15 s.
 */
import { readable, type Readable } from 'svelte/store';
import {
  AGENT_STATUS_NO_TICKET,
  agentStatusId,
  deriveAgentHealth,
  parseAgentStatusId,
  type AgentHealth,
  type AgentStatus,
} from '@tm/shared';

export { deriveAgentHealth, agentStatusId, parseAgentStatusId, AGENT_STATUS_NO_TICKET };
export type { AgentHealth, AgentStatus };

/**
 * A status document with its id. Spelled out rather than imported from
 * $lib/stores so this module stays free of Firebase — it is the display half,
 * and the listeners live in ./agentStatus.
 */
export type Status = AgentStatus & { id: string };

/** How often the health is recomputed (§L3: a beat a minute, so a quarter of that). */
export const HEALTH_TICK_MS = 15_000;

/**
 * Date.now() every 15 s, shared by everything on screen — one interval, not
 * one per dot. Stops as soon as the last subscriber goes.
 */
export const healthClock: Readable<number> = readable(Date.now(), (set) => {
  const id = setInterval(() => set(Date.now()), HEALTH_TICK_MS);
  return () => clearInterval(id);
});

/** The status of one agent on one ticket (null ticketId = its agent-level beat). */
export function statusOf<T extends Status>(
  rows: readonly T[],
  agentId: string,
  ticketId: string | null,
): T | null {
  const id = agentStatusId(agentId, ticketId);
  return rows.find((r) => r.id === id) ?? null;
}

/** Every status about one ticket, whichever agent wrote it. */
export const statusesOnTicket = <T extends Status>(rows: readonly T[], ticketId: string): T[] =>
  rows.filter((r) => r.ticketId === ticketId);

/**
 * The one status a ticket's card / header shows when several agents are on it:
 * the loudest thing happening — an error, then work in progress, then silence,
 * then idle, then finished.
 */
const RANK: Record<AgentHealth, number> = {
  error: 0,
  stale: 1,
  working: 2,
  idle: 3,
  done: 4,
  none: 5,
};

export function leadStatus<T extends Status>(
  rows: readonly T[],
  ticketId: string,
  now: number,
): T | null {
  let best: T | null = null;
  let bestRank = Infinity;
  for (const s of statusesOnTicket(rows, ticketId)) {
    const r = RANK[deriveAgentHealth(s, now)];
    if (r < bestRank || (r === bestRank && best != null && s.lastBeatAt > best.lastBeatAt)) {
      best = s;
      bestRank = r;
    }
  }
  return best;
}

/**
 * The one status that stands for an AGENT (People & roles, the Agents page):
 * its agent-level beat when it has one, else the loudest of its tickets.
 */
export function agentLead<T extends Status>(
  rows: readonly T[],
  agentId: string,
  now: number,
): T | null {
  const level = statusOf(rows, agentId, null);
  if (level && deriveAgentHealth(level, now) !== 'none') return level;
  let best: T | null = null;
  let bestRank = Infinity;
  for (const s of rows) {
    if (s.agentId !== agentId) continue;
    const r = RANK[deriveAgentHealth(s, now)];
    if (r < bestRank || (r === bestRank && best != null && s.lastBeatAt > best.lastBeatAt)) {
      best = s;
      bestRank = r;
    }
  }
  return best;
}

/** The tickets an agent is working on right now (the Agents page's 'active tickets'). */
export function liveTickets<T extends Status>(
  rows: readonly T[],
  agentId: string,
  now: number,
): T[] {
  return rows
    .filter((s) => s.agentId === agentId && s.ticketId !== null)
    .filter((s) => {
      const h = deriveAgentHealth(s, now);
      return h === 'working' || h === 'idle' || h === 'stale' || h === 'error';
    })
    .sort((a, b) => b.lastBeatAt - a.lastBeatAt);
}

// ───────────────────────────── how it reads ─────────────────────────────────

export interface HealthLook {
  health: AgentHealth;
  /** Tailwind background for the dot. */
  dot: string;
  /** The dot pulses only while work is actually happening. */
  pulse: boolean;
  /** 'Working', 'No signal', 'Idle', 'Finished', 'Stopped with an error'. */
  title: string;
  /** The rest of the line: the beat's message, 'for 3 min', the end time. */
  detail: string | null;
  /** 'Working · Running tests (3/12)' — title and detail in one. */
  label: string;
  /** Tailwind text colour for the line. */
  text: string;
}

/** 'No signal for 3 min' — whole minutes, and never less than one. */
export function silenceFor(since: number, now: number): string {
  const min = Math.max(1, Math.round((now - since) / 60_000));
  return min === 1 ? '1 min' : `${min} min`;
}

const TIME = (ms: number, tz?: string) =>
  new Date(ms).toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' });

/**
 * THE table in §L3, in one place — every dot in the app comes from here, so a
 * card, the drawer header, People & roles and the Agents page cannot disagree.
 */
export function healthLook(
  status: Status | AgentStatus | null | undefined,
  now: number,
  tz?: string,
): HealthLook {
  const health = deriveAgentHealth(status, now);
  const message = status?.message ?? null;
  switch (health) {
    case 'working':
      return {
        health,
        dot: 'bg-success',
        pulse: true,
        title: 'Working',
        detail: message,
        label: message ? `Working · ${message}` : 'Working',
        text: 'text-success',
      };
    case 'stale': {
      const detail = `for ${silenceFor(status!.lastBeatAt, now)}`;
      return {
        health,
        dot: 'bg-danger',
        pulse: false,
        title: 'No signal',
        detail,
        label: `No signal ${detail}`,
        text: 'text-danger',
      };
    }
    case 'idle':
      return {
        health,
        dot: 'bg-warning',
        pulse: false,
        title: 'Idle',
        detail: message,
        label: message ? `Idle · ${message}` : 'Idle',
        text: 'text-warning',
      };
    case 'done': {
      const detail = TIME(status!.endedAt ?? status!.lastBeatAt, tz);
      return {
        health,
        dot: 'bg-subtle',
        pulse: false,
        title: 'Finished',
        detail,
        label: `Finished · ${detail}`,
        text: 'text-muted',
      };
    }
    case 'error':
      return {
        health,
        dot: 'bg-danger',
        pulse: false,
        title: 'Stopped with an error',
        detail: message,
        label: message ? `Stopped with an error · ${message}` : 'Stopped with an error',
        text: 'text-danger',
      };
    case 'none':
      return { health, dot: '', pulse: false, title: '', detail: null, label: '', text: '' };
  }
}

/** Nothing to draw at all (§L3: 'no status yet → nothing'). */
export const isSilent = (look: HealthLook): boolean => look.health === 'none';

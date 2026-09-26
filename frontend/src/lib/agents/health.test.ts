import { describe, expect, it } from 'vitest';
import { agentStatusId, HEARTBEAT_STALE_MS, type AgentState, type AgentStatus } from '@tm/shared';
import { agentLead, healthLook, leadStatus, liveTickets, silenceFor, type Status } from './health';

const NOW = Date.UTC(2026, 8, 23, 10, 42);
const MIN = 60_000;

function status(
  agentId: string,
  ticketId: string | null,
  state: AgentState,
  over: Partial<AgentStatus> = {},
): Status {
  const base: AgentStatus = {
    agentId,
    ticketId,
    state,
    message: null,
    progress: null,
    lastBeatAt: NOW,
    startedAt: NOW - 10 * MIN,
    endedAt: state === 'done' || state === 'error' ? NOW : null,
    ...over,
  };
  return { ...base, id: agentStatusId(agentId, ticketId) };
}

const A = 'ag_0000000000000001';
const B = 'ag_0000000000000002';

describe('healthLook — the §L3 table, in one place', () => {
  it('🟢 pulses while a fresh beat says working, and prints the message', () => {
    const look = healthLook(status(A, 't1', 'working', { message: 'Running tests (3/12)' }), NOW);
    expect(look.health).toBe('working');
    expect(look.pulse).toBe(true);
    expect(look.dot).toBe('bg-success');
    expect(look.label).toBe('Working · Running tests (3/12)');
  });

  it('🔴 goes to "No signal for N min" once the beats stop', () => {
    const quiet = status(A, 't1', 'working', {
      lastBeatAt: NOW - 3 * MIN,
      message: 'Running tests',
    });
    const look = healthLook(quiet, NOW);
    expect(look.health).toBe('stale');
    expect(look.pulse).toBe(false);
    expect(look.label).toBe('No signal for 3 min');
    expect(look.text).toBe('text-danger');
  });

  it('holds on until the 75-second rule is actually broken', () => {
    const justInTime = status(A, 't1', 'working', { lastBeatAt: NOW - HEARTBEAT_STALE_MS });
    expect(healthLook(justInTime, NOW).health).toBe('working');
    const oneMsLate = status(A, 't1', 'working', { lastBeatAt: NOW - HEARTBEAT_STALE_MS - 1 });
    expect(healthLook(oneMsLate, NOW).health).toBe('stale');
  });

  it('🟡 idle keeps its reason, and never goes stale on its own', () => {
    const idle = status(A, 't1', 'idle', {
      message: 'waiting for an answer',
      lastBeatAt: NOW - 30 * MIN,
    });
    const look = healthLook(idle, NOW);
    expect(look.health).toBe('idle');
    expect(look.label).toBe('Idle · waiting for an answer');
  });

  it('⚪ done reads "Finished · 10:42", from the end of the run', () => {
    const look = healthLook(status(A, 't1', 'done', { endedAt: NOW }), NOW, 'UTC');
    expect(look.health).toBe('done');
    expect(look.title).toBe('Finished');
    expect(look.detail).toMatch(/10:42/);
  });

  it('🔴 error says so and carries the message', () => {
    const look = healthLook(status(A, 't1', 'error', { message: 'pnpm build failed' }), NOW);
    expect(look.health).toBe('error');
    expect(look.label).toBe('Stopped with an error · pnpm build failed');
  });

  it('shows nothing at all when there is no status yet', () => {
    const look = healthLook(null, NOW);
    expect(look.health).toBe('none');
    expect(look.label).toBe('');
  });
});

describe('silenceFor', () => {
  it('is whole minutes, and never less than one', () => {
    expect(silenceFor(NOW - 20_000, NOW)).toBe('1 min');
    expect(silenceFor(NOW - 3 * MIN, NOW)).toBe('3 min');
  });
});

describe('leadStatus — the loudest agent on a ticket', () => {
  it('prefers an error over work, and work over finished', () => {
    const rows = [status(A, 't1', 'done'), status(B, 't1', 'working'), status(A, 't2', 'error')];
    expect(leadStatus(rows, 't1', NOW)?.agentId).toBe(B);
    const withError = [...rows, status('ag_0000000000000003', 't1', 'error')];
    expect(leadStatus(withError, 't1', NOW)?.state).toBe('error');
  });

  it('counts silence as louder than working', () => {
    const rows = [
      status(A, 't1', 'working'),
      status(B, 't1', 'working', { lastBeatAt: NOW - 5 * MIN }),
    ];
    expect(leadStatus(rows, 't1', NOW)?.agentId).toBe(B);
  });

  it('is null for a ticket nothing has beaten about', () => {
    expect(leadStatus([status(A, 't1', 'working')], 't9', NOW)).toBeNull();
  });
});

describe('agentLead — what People & roles and the Agents page show', () => {
  it('prefers the agent-level beat', () => {
    const rows = [status(A, null, 'idle'), status(A, 't1', 'working')];
    expect(agentLead(rows, A, NOW)?.ticketId).toBeNull();
  });

  it('falls back to the loudest ticket when there is no agent-level beat', () => {
    const rows = [status(A, 't1', 'done'), status(A, 't2', 'working')];
    expect(agentLead(rows, A, NOW)?.ticketId).toBe('t2');
  });
});

describe('liveTickets', () => {
  it('lists the tickets still in play, newest beat first, and leaves finished ones out', () => {
    const rows = [
      status(A, 't1', 'working', { lastBeatAt: NOW - MIN }),
      status(A, 't2', 'error'),
      status(A, 't3', 'done'),
      status(B, 't4', 'working'),
      status(A, null, 'working'),
    ];
    expect(liveTickets(rows, A, NOW).map((s) => s.ticketId)).toEqual(['t2', 't1']);
  });
});

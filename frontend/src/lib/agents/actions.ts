/**
 * Agents on boards — boardAgentSet (agents.html §C, §AA2). The owner (a board
 * admin) adds; any admin re-roles or removes. The role may be 'admin' (§AA2 —
 * the old "never admin" rule is gone). Removing takes it off assignees and
 * watchers; its messages stay, and its one token (§AA1) simply stops reaching
 * that board (a legacy board token for that board is revoked).
 */
import type { AgentBoardRole, StageGrant } from '@tm/shared';
import { command, isAppError } from '$lib/api';
import { toast } from '$lib/ui';

// §AA2: the labels and one-line descriptions (Admin included) are pure data
// and live in ./access, where the tests reach them without the API.
export { AGENT_NEVER, AGENT_ROLE_HINT, AGENT_ROLE_LABEL, AGENT_ROLE_ORDER } from './access';

async function set(
  input: {
    boardId: string;
    agentId: string;
    role: AgentBoardRole | null;
    stageGrant?: StageGrant | null;
  },
  what: string,
): Promise<boolean> {
  try {
    await command('boardAgentSet', input, { toast: false });
    return true;
  } catch (e) {
    toast.error(`Could not ${what}`, isAppError(e) ? e.message : undefined);
    return false;
  }
}

export function addAgentToBoard(
  boardId: string,
  agentId: string,
  role: AgentBoardRole,
  stageGrant?: StageGrant | null,
) {
  return set(
    { boardId, agentId, role, ...(role === 'commenter' && stageGrant ? { stageGrant } : {}) },
    'add the agent',
  );
}

/** A commenter's grant means nothing for other roles: it is dropped with the change. */
export function setAgentRole(
  boardId: string,
  agentId: string,
  role: AgentBoardRole,
  hadGrant = false,
) {
  return set(
    { boardId, agentId, role, ...(role !== 'commenter' && hadGrant ? { stageGrant: null } : {}) },
    'change the role',
  );
}

export function setAgentGrant(
  boardId: string,
  agentId: string,
  role: AgentBoardRole,
  stageGrant: StageGrant | null,
) {
  return set({ boardId, agentId, role, stageGrant }, 'change the stage grant');
}

export function removeAgentFromBoard(boardId: string, agentId: string) {
  return set({ boardId, agentId, role: null }, 'remove the agent');
}

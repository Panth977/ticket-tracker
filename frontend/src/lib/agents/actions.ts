/**
 * Agents on boards — boardAgentSet (agents.html §C). The owner (a board admin)
 * adds; any admin re-roles or removes. Removing takes it off assignees and
 * watchers and revokes its tokens for that board; its messages stay.
 */
import type { AgentBoardRole, StageGrant } from '@tm/shared';
import { command, isAppError } from '$lib/api';
import { toast } from '$lib/ui';

export const AGENT_ROLE_LABEL: Record<AgentBoardRole, string> = {
  editor: 'Editor',
  commenter: 'Commenter',
  viewer: 'Viewer',
};
export const AGENT_ROLE_HINT: Record<AgentBoardRole, string> = {
  editor: 'Create and edit every ticket, move anywhere',
  commenter: 'Read, post in threads, move within a stage grant',
  viewer: 'Read only',
};

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

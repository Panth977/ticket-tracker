/**
 * Agent profiles as the app sees them (agents.html §B, §C). Only the owner can
 * read agents/{id}, so "my agents" is one query on ownerUid. Pure helpers are
 * split out so the list / detail pages and tests share them.
 */
import type { Readable } from 'svelte/store';
import {
  AGENT_DESCRIPTION_MAX,
  AGENT_NAME_MAX,
  AGENT_SYSTEM_PROMPT_MAX,
  newAgentId,
  paths,
  type Agent,
  type Board,
  type BoardRole,
} from '@tm/shared';
import { queryStore, type QueryState, type WithId } from '$lib/stores';

export { AGENT_DESCRIPTION_MAX, AGENT_NAME_MAX, AGENT_SYSTEM_PROMPT_MAX };

/** Every agent I own (archived included — filter on archivedAt). */
export function myAgents(uid: string | null | undefined): Readable<QueryState<Agent>> {
  return queryStore<Agent>(uid ? { path: paths.agents(), where: [['ownerUid', '==', uid]] } : null);
}

/** Active first, by name; archived last, newest archived first. */
export function sortAgents<T extends Pick<Agent, 'name' | 'archivedAt'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    const aa = a.archivedAt != null;
    const ba = b.archivedAt != null;
    if (aa !== ba) return aa ? 1 : -1;
    if (aa && ba) return (b.archivedAt ?? 0) - (a.archivedAt ?? 0);
    return a.name.localeCompare(b.name);
  });
}

/** A client-side agent id (CSPRNG) so a retried create is one agent. */
export function freshAgentId(): string {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) return newAgentId();
  const buf = new Uint32Array(16);
  c.getRandomValues(buf);
  let i = 0;
  return newAgentId(() => buf[i++]! / 2 ** 32);
}

export interface AgentBoardRow {
  board: WithId<Board>;
  role: BoardRole;
}

/** The boards (of mine) an agent is on — the board's access map holds agents too. */
export function boardsOfAgent(boards: readonly WithId<Board>[], agentId: string): AgentBoardRow[] {
  return boards
    .filter((b) => b.archivedAt == null && b.access?.[agentId] != null)
    .map((b) => ({ board: b, role: b.access[agentId]! }))
    .sort((a, b) => a.board.name.localeCompare(b.board.name));
}

/** Boards I could add the agent to: I'm admin there (only the owner, an admin, adds) and it isn't on yet. */
export function boardsToAddAgent(
  boards: readonly WithId<Board>[],
  me: string,
  agentId: string,
): WithId<Board>[] {
  return boards
    .filter(
      (b) => b.archivedAt == null && b.access?.[me] === 'admin' && b.access?.[agentId] == null,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface AgentDraft {
  name: string;
  description: string;
  systemPrompt: string;
}

export function draftOf(a: Pick<Agent, 'name' | 'description' | 'systemPrompt'>): AgentDraft {
  return { name: a.name, description: a.description ?? '', systemPrompt: a.systemPrompt };
}

/** Problems with a draft, by field (empty = saveable). */
export function draftErrors(d: AgentDraft): Partial<Record<keyof AgentDraft, string>> {
  const e: Partial<Record<keyof AgentDraft, string>> = {};
  const name = d.name.trim();
  if (!name) e.name = 'Give it a name, e.g. “Builder”.';
  else if (name.length > AGENT_NAME_MAX) e.name = `At most ${AGENT_NAME_MAX} characters.`;
  if (d.description.trim().length > AGENT_DESCRIPTION_MAX)
    e.description = `At most ${AGENT_DESCRIPTION_MAX} characters.`;
  if (d.systemPrompt.length > AGENT_SYSTEM_PROMPT_MAX)
    e.systemPrompt = `At most ${AGENT_SYSTEM_PROMPT_MAX.toLocaleString('en-US')} characters.`;
  return e;
}

/** Only what changed, shaped for agentUpdate (description '' → null). */
export function draftPatch(
  saved: Pick<Agent, 'name' | 'description' | 'systemPrompt'>,
  d: AgentDraft,
): Partial<{ name: string; description: string | null; systemPrompt: string }> {
  const p: Partial<{ name: string; description: string | null; systemPrompt: string }> = {};
  const name = d.name.trim();
  const desc = d.description.trim() || null;
  if (name !== saved.name) p.name = name;
  if (desc !== (saved.description ?? null)) p.description = desc;
  if (d.systemPrompt !== saved.systemPrompt) p.systemPrompt = d.systemPrompt;
  return p;
}

/** A starting point for a new agent's system prompt (Markdown). */
export const STARTER_PROMPT = `# Role
You are {name}, an agent working on this board's tickets.

# How you work
- Read the ticket, its description and the whole thread before acting.
- Post progress as a comment. Put plans and reports in a **Markdown** (.md) or **HTML** (.html) file attached to the ticket.
- Move the ticket when your part is done; never beyond the stages you are allowed.
- If something is unclear, ask in the thread and wait.
`;

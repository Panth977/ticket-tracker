/**
 * Shared fixtures for the phase-3 suites (docs/plan/agents.html §L):
 * a board with an agent on it, plus readers for the documents §L adds.
 */
import { paths, type AgentInboxEvent, type Message, type Ticket } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import type { WaitingOn } from '../../src/tickets/questions.js';
import { call, type TestUser } from '../harness/index.js';
import { makeAgent, type TestAgent } from '../agents/helpers.js';
import { getDocData, seedBoard } from '../tickets/helpers.js';
import { listOf, listsOf, msgOf, msgsOf } from '../tickets/store.js';

export interface Scene {
  boardId: string;
  boardKey: string;
  ticketId: string;
  agent: TestAgent;
}

/** A board, an agent on it as `role`, and one active ticket. */
export async function scene(
  admin: TestUser,
  opts: {
    editors?: TestUser[];
    commenters?: TestUser[];
    viewers?: TestUser[];
    role?: 'editor' | 'commenter' | 'viewer';
    assignees?: string[];
  } = {},
): Promise<Scene> {
  const b = await seedBoard({
    admin,
    ...(opts.editors ? { editors: opts.editors } : {}),
    ...(opts.commenters ? { commenters: opts.commenters } : {}),
    ...(opts.viewers ? { viewers: opts.viewers } : {}),
  });
  const agent = await makeAgent(admin, { boardId: b.id, role: opts.role ?? 'editor' });
  const { ticketId } = await call(admin, 'ticketCreate', { boardId: b.id, title: 'Build it' });
  if (opts.assignees?.length)
    await call(admin, 'ticketUpdate', {
      boardId: b.id,
      ticketId,
      patch: { assigneeUids: opts.assignees },
    });
  return { boardId: b.id, boardKey: b.key, ticketId, agent };
}

export const ticketOf = (boardId: string, ticketId: string): Promise<Ticket> =>
  getDocData<Ticket>(paths.ticket(boardId, ticketId)).then((t) => t!);

export const waitingOnOf = async (boardId: string, ticketId: string): Promise<WaitingOn | null> =>
  ((await ticketOf(boardId, ticketId)) as Ticket & { waitingOn?: WaitingOn | null }).waitingOn ??
  null;

export const tasklistProgressOf = async (
  boardId: string,
  ticketId: string,
): Promise<{ done: number; total: number } | null> =>
  (
    (await ticketOf(boardId, ticketId)) as Ticket & {
      tasklistProgress?: { done: number; total: number } | null;
    }
  ).tasklistProgress ?? null;

export const messageOf = (boardId: string, ticketId: string, messageId: string): Promise<Message> =>
  msgOf(boardId, ticketId, messageId).then((m) => m!);

export const messagesOf = (boardId: string, ticketId: string) =>
  msgsOf(boardId, ticketId).then((ms) => ms.sort((a, b) => a.createdAt - b.createdAt));

export const tasklistsOf = (boardId: string, ticketId: string) => listsOf(boardId, ticketId);

export const tasklistOf = (boardId: string, ticketId: string, listId: string) =>
  listOf(boardId, ticketId, listId);

// Heartbeat status left Firestore in phase 15 (§W): it is an RTDB node now,
// read with liveStatus() from test/agents/helpers.ts, and everything the old
// statusOf() was used for lives in test/agents/live.emu.test.ts.

/** The agent's inbox, oldest first (event ids sort by time). */
export async function inboxOf(agentId: string): Promise<(AgentInboxEvent & { id: string })[]> {
  const snap = await db().collection(paths.agentEvents(agentId)).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as AgentInboxEvent) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

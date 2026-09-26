/**
 * THE AGENT INBOX (docs/plan/agents.html §D). Agents never get push, email or
 * WhatsApp — every notify() recipient that is an agent gets a document in
 * agentInbox/{agentId}/events/{eventId} instead, which its token reads through
 * REST (GET /v1/events, the SSE stream, POST /v1/events/ack) or MCP
 * (get_events / ack_events).
 *
 * WHO (pure, agentRecipients):
 *   mentioned        the mentioned agents, unconditionally
 *   assigned         the newly assigned agents (extra.recipients)
 *   unassigned       agents taken off the ticket (agentEventsSafe from the commands)
 *   comment / stage / updated / created / state
 *                    agents ASSIGNED TO or WATCHING the ticket (or, for a bulk
 *                    digest with explicit recipients, the agents among them)
 *   dueSoon / overdue / invited   never (not agent events)
 *   always: on the board (access), − the actor (an agent's own actions never
 *   reach its own inbox), − extra.exclude (no double event with 'mentioned').
 *
 * Event ids come from agentEventId(now, suffix): they sort by time, so the id
 * is also the feed cursor.
 *
 * AND THEN THE AGENT IS WOKEN (§W): writing the events also bumps
 * agents/{agentId}/wake in the RTDB — one tiny write for all the recipients of
 * one event — so an orchestrator holding a stream on that node hears about its
 * inbox in under a second and an idle one costs nothing at all.
 */
import {
  agentEventId,
  isAgentId,
  paths,
  type AgentEventType,
  type AgentInboxEvent,
  type Board,
  type CommandCtx,
  type NotifyEvent,
  type TicketWithId,
} from '@tm/shared';
import type { ServerCtx } from '../runtime/context.js';
import { typedDoc } from '../runtime/converters.js';
import { db } from '../runtime/firebase.js';
import { afterCommit } from '../tickets/effects.js';
import { actorName } from '../tickets/writes.js';
import { randomIds } from '../adapters/clock.js';
import { wakeAgents } from '../platform/rtdbPaths.js';

/** notify() event → agent inbox event type (null = agents do not hear it). */
export function agentEventType(event: NotifyEvent): AgentEventType | null {
  switch (event) {
    case 'assigned':
    case 'mentioned':
    case 'comment':
    case 'stage':
    case 'updated':
    case 'created':
      return event;
    case 'state':
      // Archived / restored: a change to the ticket.
      return 'updated';
    case 'dueSoon':
    case 'overdue':
    case 'invited':
      return null;
    case 'question':
      // Phase 3 (§L1): a question is asked OF PEOPLE. The asking agent hears
      // the outcome instead, as 'question_answered' / 'question_cancelled'
      // (written by the question commands, not by notify()).
      return null;
    case 'agentSilence':
      // Phase 3 (§L3): 'your agent went quiet' is for the agent's OWNER. The
      // agent itself is, by definition, not listening.
      return null;
  }
}

export interface AgentRecipientInput {
  event: NotifyEvent;
  actor: string;
  ticket: Pick<TicketWithId, 'assigneeUids' | 'watcherUids'> | null;
  /** board.access — agents are on the board when they hold a role there. */
  access: Board['access'];
  recipients?: readonly string[] | undefined;
  mentioned?: readonly string[] | undefined;
  exclude?: readonly string[] | undefined;
}

/** Which agents hear about this notify() event (pure). */
export function agentRecipients(i: AgentRecipientInput): string[] {
  if (!agentEventType(i.event) || !i.ticket) return [];
  let base: readonly string[];
  if (i.event === 'mentioned') base = i.mentioned ?? i.recipients ?? [];
  else if (i.event === 'assigned') base = i.recipients ?? [];
  else if (i.recipients) base = i.recipients;
  else base = [...i.ticket.assigneeUids, ...i.ticket.watcherUids];

  const exclude = new Set(i.exclude ?? []);
  const out: string[] = [];
  for (const id of new Set(base)) {
    if (!isAgentId(id) || id === i.actor || exclude.has(id)) continue;
    if (!Object.prototype.hasOwnProperty.call(i.access, id)) continue;
    out.push(id);
  }
  return out;
}

export interface AgentEventExtra {
  messageId?: string | undefined;
  /** The full line ('Priya assigned you'). */
  summary: string;
  /**
   * Phase 3 (§L1): question_answered / question_cancelled carry the question
   * itself — its id, title, status and (for an answer) the values the person
   * submitted, so the agent needs no second call to act on it.
   */
  question?: AgentInboxEvent['question'];
}

/**
 * Write one event per agent. The actor is recorded as given (null = the
 * system). Returns agentId → eventId.
 */
export async function writeAgentEvents(
  type: AgentEventType,
  ticket: Pick<TicketWithId, 'id' | 'boardId' | 'key'>,
  ctx: Pick<CommandCtx, 'actor' | 'now'>,
  agentIds: readonly string[],
  extra: AgentEventExtra,
  actor: string | null = ctx.actor,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!agentIds.length) return out;
  const batch = db().batch();
  // A random suffix: unique per agent per millisecond whatever ids port the
  // caller has (router ctx is a plain CommandCtx without one).
  const rnd = randomIds();
  for (const agentId of agentIds) {
    const eventId = agentEventId(ctx.now, rnd.id());
    const ev: AgentInboxEvent = {
      type,
      boardId: ticket.boardId,
      ticketId: ticket.id,
      ticketKey: ticket.key,
      ...(extra.messageId ? { messageId: extra.messageId } : {}),
      ...(extra.question ? { question: extra.question } : {}),
      actor,
      summary: extra.summary.slice(0, 500),
      createdAt: ctx.now,
      ackedAt: null,
    };
    batch.set(typedDoc('agentInbox', paths.agentEvent(agentId, eventId)), ev);
    out[agentId] = eventId;
  }
  await batch.commit();
  // §W: one RTDB write for however many agents this event reached, so an idle
  // orchestrator can hold a stream on agents/{agentId}/wake instead of asking
  // GET /v1/events every 30 seconds whether anything happened. A wake is a
  // hint, never the event: the agent still reads its inbox with a cursor.
  await wakeAgents(agentIds, ctx.now, ticket.boardId);
  return out;
}

/** 'Priya' + 'assigned you' + ENG-42 → 'Priya assigned you · ENG-42'. */
export function agentSummary(byName: string | null, line: string, ticketKey: string): string {
  const who = byName ? `${byName} ` : '';
  return `${who}${line} · ${ticketKey}`;
}

/**
 * For events that have no notify() counterpart ('unassigned'): after commit,
 * never throws. Only agents on the board, never the actor.
 */
export function agentEventsSafe(
  type: AgentEventType,
  ticket: TicketWithId,
  ctx: ServerCtx,
  principalIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(principalIds)].filter((id) => isAgentId(id) && id !== ctx.actor);
  if (!ids.length) return Promise.resolve();
  return afterCommit(`agentInbox:${type}`, async () => {
    const board = (await db().doc(paths.board(ticket.boardId)).get()).data() as Board | undefined;
    if (!board) return;
    const onBoard = ids.filter((id) => Object.prototype.hasOwnProperty.call(board.access, id));
    if (!onBoard.length) return;
    const byName = await actorName(ctx, ticket.boardId);
    const line = type === 'unassigned' ? 'unassigned you' : type;
    await writeAgentEvents(type, ticket, ctx, onBoard, {
      summary: agentSummary(byName, line, ticket.key),
    });
  });
}

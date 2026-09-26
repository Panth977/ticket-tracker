/**
 * agentHeartbeat — 'is the agent alive?' (docs/plan/agents.html §L3, §W).
 *
 *   canHeartbeat() — a token acting as the agent (or a board admin) with
 *   status:write. The agent must hold a role on the board.
 *
 * WRITES EXACTLY ONE RTDB NODE: status/{boardId}/{agentId}/{ticketId|'_'}.
 *
 * IT USED TO BE A FIRESTORE TRANSACTION, and that was the single most wasteful
 * write in the system (§W): 1,440 beats per agent per day, each a read plus a
 * write in Firestore, each one then re-delivered to a listener in every open
 * tab. The RTDB bills BANDWIDTH, so the same beat is ~100 bytes of traffic and
 * zero operations. Nothing durable needs the old boards/{b}/agentStatus
 * document — a beat is only ever interesting while it is recent, staleness is
 * derived from `at` wherever it is read, and the sweep's own 'already told the
 * owner' marker lives under silence/ — so it is no longer written at all.
 *
 * Still through the API, still scope-checked: an agent does not write this node
 * itself, so a token cannot claim to be working on a board it cannot reach.
 *
 *   startedAt  the first beat of THIS run: kept while the run continues, reset
 *              when work starts again after a done / error beat
 *   endedAt    set by a 'done' or 'error' beat, cleared when work resumes
 *
 * THE TICKET IS NEVER WRITTEN: a beat a minute must not retrigger the ticket's
 * search indexing, its triggers, or every listener watching it.
 */
import { agentStatusId, errors, isAgentId } from '@tm/shared';
import { canHeartbeat } from '@tm/shared/logic/index';
import { beat } from '../platform/rtdbPaths.js';
import { loadBoard, loadTicket } from '../tickets/access.js';
import { isMember } from '../tickets/validate.js';
import { defineCommand } from './_registry.js';

export default defineCommand('agentHeartbeat', async (ctx, input) => {
  const { boardId } = input;
  const board = await loadBoard(ctx, boardId);

  const agentId = input.agentId ?? (isAgentId(ctx.actor) ? ctx.actor : null);
  if (!agentId) throw errors.invalid('Which agent is this beat for?', { field: 'agentId' });
  if (!canHeartbeat(ctx, board, agentId))
    throw errors.forbidden('Only the agent itself (or a board admin) can beat for it');
  // An agent that is not on this board has no status here.
  if (!isMember(board, agentId)) throw errors.not_found('Agent not found on this board');

  const ticketId = input.ticketId ?? null;
  // A beat about a ticket names a real one — but never writes to it.
  if (ticketId) await loadTicket(boardId, ticketId);

  await beat(boardId, agentId, ticketId, {
    state: input.state,
    message: input.message ?? null,
    progress: input.progress ?? null,
    at: ctx.now,
  });

  // statusId is kept in the response: it is the id every door and the SDK
  // already speak, and it is still exactly agentId + '__' + (ticketId | '_').
  return { ok: true as const, statusId: agentStatusId(agentId, ticketId), at: ctx.now };
});

/**
 * boardAgentSet {boardId, agentId, role | null, stageGrant?} (agents.html §C).
 *
 *   ADD (agent not on the board yet): a board admin who OWNS the agent, the
 *     agent not archived, the board not archived. No invite: it joins
 *     directly. A non-owner gets 404 for the agent (agents are private).
 *   CHANGE role / stageGrant: any board admin.
 *   REMOVE (role null): any board admin. Like removing a person — off
 *     assignees and watchers of active tickets, its messages stay — and its
 *     tokens for this board are revoked (revokedReason 'agentRemoved').
 *   Never 'admin' (the request schema has no such role).
 *
 * Writes: access[agentId] and stageGrants[agentId] on the board (readerUids
 * and editorUids stay people-only — deriveAccess), and members/{agentId}
 * { kind: 'agent', … } for the pickers.
 */
import { errors, isAgentId, type StageGrant } from '@tm/shared';
import { agentMemberDoc, agentRef, removeAgentFromBoard } from '../agents/shared.js';
import type { ServerCtx } from '../runtime/context.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { assertActive, boardRef, deriveAccess, loadBoard, memberRef } from './boardShared.js';

function checkGrant(board: { stages: { id: string }[] }, grant: StageGrant): StageGrant {
  const ids = new Set(board.stages.map((s) => s.id));
  const bad = grant.stages.filter((s) => !ids.has(s));
  if (bad.length) throw errors.invalid('Unknown stage ids', { stageIds: bad, field: 'stageGrant' });
  return { ...grant, stages: [...new Set(grant.stages)] };
}

export default defineCommand('boardAgentSet', async (ctx: ServerCtx, input) => {
  const { boardId, agentId, role } = input;
  if (isAgentId(ctx.actor)) throw errors.forbidden('Agents cannot manage board members');

  if (role === null) {
    if (input.stageGrant !== undefined && input.stageGrant !== null)
      throw errors.invalid('A removed agent has no stage grant', { field: 'stageGrant' });
    await removeAgentFromBoard(ctx, boardId, agentId, 'agentRemoved', async (tx) => {
      await loadBoard(tx, boardId, ctx, 'admin');
    });
    return { ok: true as const };
  }

  await runTx(async (tx) => {
    // ── reads ──
    const board = await loadBoard(tx, boardId, ctx, 'admin');
    const agent = await txGet(tx, agentRef(agentId));
    const member = await txGet(tx, memberRef(boardId, agentId));
    const onBoard = Object.prototype.hasOwnProperty.call(board.access, agentId);

    if (role !== 'commenter' && input.stageGrant)
      throw errors.invalid('Stage grants are for commenters only', { field: 'stageGrant' });

    const access = { ...board.access };
    const stageGrants = { ...board.stageGrants };
    // Absent = unchanged (or none, when adding); null clears.
    let grant: StageGrant | null =
      input.stageGrant === undefined ? (stageGrants[agentId] ?? null) : input.stageGrant;
    if (role !== 'commenter') grant = null;
    if (grant) grant = checkGrant(board, grant);

    if (!onBoard) {
      // Adding: only the owner may put their agent on a board.
      if (!agent || agent.ownerUid !== ctx.actor) throw errors.not_found('Agent not found');
      if (agent.archivedAt !== null)
        throw errors.conflict('This agent is archived — restore it first');
      assertActive(board);
    } else if (!agent) {
      // On the board but its profile is gone (should not happen): leave it be.
      throw errors.not_found('Agent not found');
    }

    // ── writes ──
    access[agentId] = role;
    if (grant) stageGrants[agentId] = grant;
    else delete stageGrants[agentId];
    tx.update(boardRef(boardId), { access, stageGrants, ...deriveAccess(access) });
    if (!onBoard || !member) {
      tx.set(
        memberRef(boardId, agentId),
        agentMemberDoc(agentId, agent, role, grant, ctx.actor, ctx.now),
      );
    } else {
      tx.set(memberRef(boardId, agentId), { role, stageGrant: grant }, { merge: true });
    }
  });
  return { ok: true as const };
});

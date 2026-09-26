/**
 * agentArchive (agents.html §B) — the owner only (404 otherwise).
 *
 *   archive  archivedAt = now; the agent is taken off EVERY board it is on
 *            exactly like boardAgentSet role:null (off assignees and
 *            watchers, its messages stay), and every token acting as it is
 *            revoked (revokedReason 'agentArchived'). Archiving twice is ok.
 *   restore  archivedAt = null. It rejoins no board and no token comes back.
 */
import {
  agentBoardIds,
  agentRef,
  loadOwnAgent,
  removeAgentFromBoard,
  requirePerson,
  revokeAgentTokens,
} from '../agents/shared.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

export default defineCommand('agentArchive', async (ctx, input) => {
  const owner = requirePerson(ctx);
  const { agentId, action } = input;

  await runTx(async (tx) => {
    const agent = await loadOwnAgent(agentId, owner, tx);
    if (action === 'archive' && agent.archivedAt === null)
      tx.update(agentRef(agentId), { archivedAt: ctx.now, updatedAt: ctx.now });
    if (action === 'restore' && agent.archivedAt !== null)
      tx.update(agentRef(agentId), { archivedAt: null, updatedAt: ctx.now });
  });
  if (action === 'restore') return { ok: true as const, boardsLeft: 0, tokensRevoked: 0 };

  // Archived first, so boardAgentSet can no longer add it back while we sweep.
  let boardsLeft = 0;
  let tokensRevoked = 0;
  for (const boardId of await agentBoardIds(agentId)) {
    const r = await removeAgentFromBoard(ctx, boardId, agentId, 'agentArchived');
    if (r.removed) boardsLeft++;
    tokensRevoked += r.tokensRevoked;
  }
  // Tokens for boards it had already left (or never joined) go as well.
  tokensRevoked += await revokeAgentTokens(owner, agentId, null, 'agentArchived', ctx.now);
  return { ok: true as const, boardsLeft, tokensRevoked };
});

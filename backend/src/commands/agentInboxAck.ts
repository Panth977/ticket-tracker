/**
 * agentInboxAck (agents.html §D) — mark agent inbox events handled.
 *
 *   who   a token acting as THAT agent (REST POST /v1/events/ack, MCP
 *         ack_events), or the agent's owner in the app. Another agent → 403;
 *         a person who does not own it → 404 (agents are private).
 *   ids   ackedAt = now on each named event that is not acked yet; unknown
 *         ids are skipped (acking twice is ok).
 *   upTo  every unacked event whose id ≤ upTo — event ids sort by time
 *         (agentEventId), so the feed cursor doubles as the bound.
 */
import { FieldPath } from 'firebase-admin/firestore';
import { errors, isAgentId, paths } from '@tm/shared';
import { loadOwnAgent } from '../agents/shared.js';
import { inBatches } from './boardShared.js';
import { typedCol, typedDoc } from '../runtime/converters.js';
import { db } from '../runtime/firebase.js';
import { defineCommand } from './_registry.js';

const PAGE = 400;

export default defineCommand('agentInboxAck', async (ctx, input) => {
  const { agentId } = input;
  if (isAgentId(ctx.actor)) {
    if (ctx.actor !== agentId)
      throw errors.forbidden("A token can only ack its own agent's events");
  } else {
    await loadOwnAgent(agentId, ctx.actor);
  }

  let acked = 0;
  if (input.ids) {
    const refs = [...new Set(input.ids)].map((id) =>
      typedDoc('agentInbox', paths.agentEvent(agentId, id)),
    );
    const snaps = await db().getAll(...refs);
    const open = snaps.filter((s) => s.exists && s.get('ackedAt') == null);
    await inBatches(open, (b, s) => b.update(s.ref, { ackedAt: ctx.now }));
    acked = open.length;
  } else {
    const col = typedCol('agentInbox', paths.agentEvents(agentId));
    for (;;) {
      const snap = await col
        .where('ackedAt', '==', null)
        .where(FieldPath.documentId(), '<=', input.upTo!)
        .orderBy(FieldPath.documentId())
        .limit(PAGE)
        .get();
      await inBatches(snap.docs, (b, d) => b.update(d.ref, { ackedAt: ctx.now }));
      acked += snap.size;
      if (snap.size < PAGE) break;
    }
  }
  return { ok: true as const, acked };
});

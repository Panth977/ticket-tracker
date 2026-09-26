/**
 * agentCreate (docs/plan/agents.html §B) — any signed-in person; they become
 * the owner. App-only (no token scope reaches it).
 *
 *   agentId      optional, client-chosen, so the picture can be uploaded to
 *                users/{me}/agents/{agentId}/avatar/… before the profile
 *                exists; a taken id → 409
 *   avatarPath   under that prefix, uploaded, an image, ≤ 5 MB
 *   icon         a prebuilt icon id (AGENT_ICON_IDS) — the zod enum already
 *                refused anything else; shown when there is no picture
 *   50 live agents per person → 409 (archive one first)
 */
import { errors, type Agent } from '@tm/shared';
import {
  agentRef,
  checkAgentAvatar,
  MAX_AGENTS_PER_OWNER,
  newAgentIdFrom,
  requirePerson,
} from '../agents/shared.js';
import { typedCol } from '../runtime/converters.js';
import { runTx, txGet } from '../runtime/tx.js';
import { paths } from '@tm/shared';
import { defineCommand } from './_registry.js';

export default defineCommand('agentCreate', async (ctx, input) => {
  const owner = requirePerson(ctx);
  const agentId = input.agentId ?? newAgentIdFrom(ctx);
  if (input.avatarPath) {
    if (!input.agentId)
      throw errors.invalid('Choose the agentId up front to upload a picture with the profile', {
        field: 'avatarPath',
      });
    await checkAgentAvatar(input.avatarPath, owner, agentId);
  }

  // The cap counts live agents only; an archived one can be restored later
  // (agentArchive re-checks nothing: restoring is rare and owner-driven).
  const live = await typedCol('agents', paths.agents())
    .where('ownerUid', '==', owner)
    .where('archivedAt', '==', null)
    .count()
    .get();
  if (live.data().count >= MAX_AGENTS_PER_OWNER)
    throw errors.conflict(`You have ${MAX_AGENTS_PER_OWNER} agents — archive one first`, {
      limit: MAX_AGENTS_PER_OWNER,
    });

  await runTx(async (tx) => {
    if (await txGet(tx, agentRef(agentId)))
      throw errors.conflict('An agent with this id already exists', { agentId });
    const doc: Agent = {
      ownerUid: owner,
      name: input.name,
      avatarPath: input.avatarPath ?? null,
      icon: input.icon ?? null,
      systemPrompt: input.systemPrompt ?? '',
      description: input.description?.trim() ? input.description.trim() : null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      archivedAt: null,
    };
    tx.create(agentRef(agentId), doc);
  });
  return { agentId };
});

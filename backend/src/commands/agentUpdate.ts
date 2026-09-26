/**
 * agentUpdate (agents.html §B) — the owner only (404 for anyone else: agents
 * are private), not archived (409).
 *
 *   avatarPath  under users/{owner}/agents/{agentId}/avatar/, uploaded, an
 *               image, ≤ 5 MB; the previous picture is deleted. null removes it.
 *   icon        a prebuilt icon id (AGENT_ICON_IDS); null clears it. The
 *               picture is untouched either way (avatarPath > icon > initials).
 *   name / avatarPath / icon / description changed → copied to members/{agentId}
 *               on every board the agent is on (like a person's profile).
 *   systemPrompt is private to the owner and the agent's tokens; it is never
 *               copied anywhere.
 */
import { errors, storage, type BoardMember } from '@tm/shared';
import { ports } from '../adapters/index.js';
import {
  agentRef,
  checkAgentAvatar,
  fanOutAgentToMembers,
  loadOwnAgent,
  requirePerson,
} from '../agents/shared.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

export default defineCommand('agentUpdate', async (ctx, input) => {
  const owner = requirePerson(ctx);
  const { agentId } = input;
  // Ownership first, so a stranger learns nothing from the avatar checks.
  await loadOwnAgent(agentId, owner);
  if (input.avatarPath) await checkAgentAvatar(input.avatarPath, owner, agentId);

  const before = await runTx(async (tx) => {
    const agent = await loadOwnAgent(agentId, owner, tx);
    if (agent.archivedAt !== null)
      throw errors.conflict('This agent is archived — restore it first');
    const u: Record<string, unknown> = {};
    if (input.name !== undefined) u.name = input.name;
    if (input.description !== undefined)
      u.description = input.description?.trim() ? input.description.trim() : null;
    if (input.systemPrompt !== undefined) u.systemPrompt = input.systemPrompt;
    if (input.avatarPath !== undefined) u.avatarPath = input.avatarPath;
    if (input.icon !== undefined) u.icon = input.icon;
    if (Object.keys(u).length) tx.update(agentRef(agentId), { ...u, updatedAt: ctx.now });
    return agent;
  });

  const fan: Partial<Pick<BoardMember, 'name' | 'avatarPath' | 'icon' | 'description'>> = {};
  if (input.name !== undefined && input.name !== before.name) fan.name = input.name;
  if (input.avatarPath !== undefined && input.avatarPath !== before.avatarPath)
    fan.avatarPath = input.avatarPath;
  if (input.icon !== undefined && input.icon !== (before.icon ?? null)) fan.icon = input.icon;
  if (input.description !== undefined) {
    const d = input.description?.trim() ? input.description.trim() : null;
    if (d !== before.description) fan.description = d;
  }
  await fanOutAgentToMembers(agentId, fan);

  // The previous picture goes (only ever this agent's own avatar objects).
  if (
    fan.avatarPath !== undefined &&
    before.avatarPath &&
    before.avatarPath.startsWith(storage.agentAvatarPrefix(owner, agentId))
  )
    await ports()
      .files.delete(before.avatarPath)
      .catch((e) => console.warn('[agentUpdate] old avatar delete failed', e));

  return { ok: true as const };
});

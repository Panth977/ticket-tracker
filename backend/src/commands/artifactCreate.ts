/**
 * artifactCreate (docs/plan/artifacts.html §B, §C4) — any allowed person, or
 * an ACCOUNT token with artifacts:write; they become its owner.
 *
 * AN AGENT MAY CREATE ONE — FOR ITS OWNER. With artifacts:write on its token,
 * an agent's create makes an artifact whose owner is the PERSON the agent
 * belongs to, with the agent on it as { build: true, data: 'write' } (§AA3 —
 * what 'editor' used to mean). So "my agent made this" shows up in that
 * person's sidebar at once, the agent can publish to it and fill its data,
 * and it never owns anything: sharing, renaming and deleting stay the person's. The
 * owner gets an inbox row, because nobody clicked anything to make it.
 *
 * A board token acting as a PERSON is still refused, for the same reason it
 * reaches no artifact at all (artifacts/shared.ts): it was issued for a board.
 *
 * The artifact starts empty — currentBuild null, which the host page shows as
 * "nothing published yet" — and the RTDB mirror is written after the commit.
 */
import {
  ARTIFACT_AGENT_FULL,
  defaultIndicator,
  errors,
  isAgentId,
  paths,
  type Artifact,
} from '@tm/shared';
import { agentRef } from '../agents/shared.js';
import {
  artifactInboxRow,
  artifactRef,
  syncArtifactMirror,
  withMembers,
} from '../artifacts/shared.js';
import { typedDoc } from '../runtime/converters.js';
import { defineCommand } from './_registry.js';
import { markOnCreate } from './indicatorShared.js';

export default defineCommand('artifactCreate', async (ctx, input) => {
  const agentId = isAgentId(ctx.actor) ? ctx.actor : null;
  // An agent token always names its person (CommandCtx.ownerUid); without one
  // there is nobody to own the artifact, so there is no artifact.
  if (agentId && !ctx.ownerUid) throw errors.forbidden('This agent has no owner to create for');
  const ownerUid = agentId ? ctx.ownerUid! : ctx.actor;
  if (!agentId && ctx.keyId && ctx.boardIds !== null && ctx.boardIds !== undefined)
    throw errors.forbidden(
      'A board token cannot create artifacts — use an account token (Account › Tokens)',
    );

  const artifactId = ctx.ids.id();
  const artifact: Artifact = {
    name: input.name,
    description: input.description || null,
    ...markOnCreate(input, defaultIndicator(input.name)),
    ownerUid,
    ...withMembers({ [ownerUid]: 'owner' }),
    // Always the OBJECT form from §AA3 on (never the old literal 'editor').
    agents: agentId ? { [agentId]: { ...ARTIFACT_AGENT_FULL } } : {},
    readOnly: false,
    archivedAt: null,
    currentBuild: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  await artifactRef(artifactId).create(artifact);
  await syncArtifactMirror(artifactId, artifact);
  if (agentId) {
    // In-app only, and never allowed to fail the create (as in artifactPublish).
    const name = (await agentRef(agentId).get()).data()?.name ?? 'An agent';
    await typedDoc('inbox', paths.inboxItem(ownerUid, `artifact_${artifactId}`))
      .set(
        artifactInboxRow(
          artifactId,
          'invited',
          `${name} created the artifact “${artifact.name}” — you own it`,
          ctx,
        ),
      )
      .catch((e) => console.warn('[artifactCreate] inbox row failed', e));
  }
  return { artifactId };
});

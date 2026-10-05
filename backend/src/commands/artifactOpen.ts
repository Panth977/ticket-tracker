/**
 * artifactOpen (docs/plan/artifacts.html §D2) — what the host page (/x/{id})
 * asks for to show an artifact. Anyone with a role; APP-ONLY (the command has
 * no scopes), because a token has no browser to show it in.
 *
 * The answer is the URL prefix of ONE build on the usercontent origin, with a
 * capability in it (artifacts/capability.ts) valid for an hour. The host asks
 * again before it runs out. It names a build id, so publishing does not break
 * a tab that is open on the old build.
 *
 * `readOnly` is the EFFECTIVE answer for this viewer — "may you write the
 * artifact's data right now" negated — so the host can hand it to the driver
 * as is: true for a viewer of a read-only artifact, and for everyone while it
 * is archived. The rules decide the same way (§E4); this only saves the
 * artifact a refused write.
 */
import { artifactCan, errors } from '@tm/shared';
import { buildUrls } from '../artifacts/capability.js';
import { buildRef, loadArtifact } from '../artifacts/shared.js';
import { defineCommand } from './_registry.js';

export default defineCommand('artifactOpen', async (ctx, { artifactId, buildId }) => {
  const { artifact, role } = await loadArtifact(null, artifactId, ctx, 'open');
  const build = buildId ?? artifact.currentBuild;
  if (!build) throw errors.conflict('Nothing has been published to this artifact yet');
  // A named build must be a kept one; the current build is known to exist.
  if (buildId && buildId !== artifact.currentBuild) {
    if (!(await buildRef(artifactId, buildId).get()).exists)
      throw errors.not_found('Build not found');
  }
  const urls = buildUrls(artifactId, build, ctx.actor, ctx.now);
  return {
    contentUrl: urls.contentUrl,
    contentBase: urls.contentBase,
    buildId: build,
    role,
    readOnly: artifact.archivedAt !== null || !artifactCan.writeData(role, artifact.readOnly),
    expiresAt: urls.expiresAt,
  };
});

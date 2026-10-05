/**
 * artifactSourceUrl — owner or editor, or an agent with `build` on it
 * (agents.html §AA3; an agent with data permission only cannot download the
 * source): a
 * short-lived link to the SOURCE zip that was published beside a build — what
 * the next agent downloads to carry on where the last one stopped (§A). The
 * newest build that has one, unless `buildId` names a build.
 *
 * The source is never served as a site and never unpacked; it is a file
 * somebody kept.
 */
import { errors } from '@tm/shared';
import { objectLink } from '../artifacts/files.js';
import { buildRef, buildsCol, loadArtifact } from '../artifacts/shared.js';
import { defineCommand } from './_registry.js';

export default defineCommand('artifactSourceUrl', async (ctx, { artifactId, buildId }) => {
  await loadArtifact(null, artifactId, ctx, 'publish');
  let found: string | null = null;
  if (buildId) {
    const b = (await buildRef(artifactId, buildId).get()).data();
    if (b?.sourcePath) found = buildId;
  } else {
    // At most ARTIFACT_BUILDS_KEPT (+ a day's publishes) documents: read them and look.
    const snap = await buildsCol(artifactId).orderBy('createdAt', 'desc').get();
    found = snap.docs.find((d) => d.data().sourcePath)?.id ?? null;
  }
  if (!found) throw errors.not_found('No source was published with this artifact');
  const link = await objectLink(artifactId, `source/${found}.zip`, ctx.actor, ctx.now);
  return { url: link.url, buildId: found, expiresAt: link.expiresAt };
});

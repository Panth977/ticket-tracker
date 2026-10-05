/**
 * artifactSetCurrent — owner or editor, or an agent with `build` (§AA3): make any KEPT build the current one
 * (a rollback is one click, §A). Builds are immutable, so this is only a
 * pointer moving; a tab open on the old build keeps working, because its
 * capability names the build it was opened with (§D2).
 */
import { errors } from '@tm/shared';
import { artifactRef, buildRef, loadArtifact } from '../artifacts/shared.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

export default defineCommand('artifactSetCurrent', async (ctx, { artifactId, buildId }) => {
  await runTx(async (tx) => {
    const { artifact } = await loadArtifact(tx, artifactId, ctx, 'publish');
    if (!(await txGet(tx, buildRef(artifactId, buildId))))
      throw errors.not_found('Build not found — only kept builds can be made current');
    if (artifact.currentBuild !== buildId)
      tx.update(artifactRef(artifactId), { currentBuild: buildId, updatedAt: ctx.now });
  });
  return { ok: true as const };
});

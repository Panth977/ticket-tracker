/**
 * The `artifactDelete` queue handler (queued by artifactDelete and by
 * artifactDataClear with `dataOnly`). Lives beside the artifact commands;
 * autoload imports commands/, and defineTask registers it — the same
 * arrangement as boardDeleteJob.ts.
 *
 * The work itself is artifacts/purge.ts; this file only decides which half.
 */
import { purgeArtifact, purgeArtifactData } from '../artifacts/purge.js';
import { defineTask } from '../runtime/functions.js';

defineTask('artifactDelete', async ({ artifactId, dataOnly }) => {
  if (dataOnly) await purgeArtifactData(artifactId);
  else await purgeArtifact(artifactId);
});

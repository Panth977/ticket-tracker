/** artifactBackendLogs: the last lines the sandbox wrote, and calls it took. */
import type { ArtifactBackendLog } from '@tm/shared';
import { gatewayCall } from '../artifacts/gateway.js';
import { loadArtifact } from '../artifacts/shared.js';
import { defineCommand } from './_registry.js';

export default defineCommand('artifactBackendLogs', async (ctx, input) => {
  await loadArtifact(null, input.artifactId, ctx, 'publish');
  return gatewayCall<{ entries: ArtifactBackendLog[]; running: boolean }>(
    'logs',
    { artifactId: input.artifactId },
    15_000,
  );
});

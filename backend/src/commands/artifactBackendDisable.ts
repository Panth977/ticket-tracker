/** artifactBackendDisable: stop it and take its routes down. Its builds stay stored. */
import { forgetBackendListeners } from '../artifacts/backendEvents.js';
import { gatewayCall } from '../artifacts/gateway.js';
import { artifactRef, loadArtifact } from '../artifacts/shared.js';
import { defineCommand } from './_registry.js';

export default defineCommand('artifactBackendDisable', async (ctx, input) => {
  await loadArtifact(null, input.artifactId, ctx, 'publish');
  await artifactRef(input.artifactId).update({ backend: null, backendBoards: [], updatedAt: ctx.now });
  forgetBackendListeners();
  await gatewayCall('reload', { artifactId: input.artifactId }, 15_000).catch(() => undefined);
  return { ok: true as const };
});

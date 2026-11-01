/** artifactBackendGet: what the Backend tab opens with. */
import { artifactPrefix, type ArtifactBackendFile } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { backendPublicUrl, gatewayCall, gatewayConfigured } from '../artifacts/gateway.js';
import { loadArtifact } from '../artifacts/shared.js';
import { defineCommand } from './_registry.js';

export default defineCommand('artifactBackendGet', async (ctx, input) => {
  const { artifactId } = input;
  const { artifact } = await loadArtifact(null, artifactId, ctx, 'publish');
  const backend = artifact.backend ?? null;
  let files: ArtifactBackendFile[] | null = null;
  if (backend) {
    const raw = await ports().files.read(artifactPrefix.storageBackend(artifactId, backend.buildId));
    files = (JSON.parse(Buffer.from(raw).toString('utf8')) as { files: ArtifactBackendFile[] }).files;
  }
  const configured = gatewayConfigured();
  const types = configured
    ? await gatewayCall<{ types: string }>('types', {}, 15_000).then((t) => t.types, () => null)
    : null;
  return { configured, url: configured ? backendPublicUrl(artifactId) : null, backend, files, types };
});

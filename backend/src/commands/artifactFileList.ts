/**
 * artifactFileList — db.storage.list(prefix): anyone with a role. Recursive
 * under the prefix, at most 1000, paths in the artifact's own view. App-only;
 * listing goes through a command for the same reason reads do (storage.rules
 * header): the rule lookup cannot be relied on.
 */
import { artifactPrefix, artifactStoragePrefix } from '@tm/shared';
import { fenced, loadArtifact } from '../artifacts/shared.js';
import { storageAdmin } from '../runtime/firebase.js';
import { defineCommand } from './_registry.js';

const MAX_LISTED = 1000;

export default defineCommand('artifactFileList', async (ctx, { artifactId, path }) => {
  await loadArtifact(null, artifactId, ctx, 'open');
  const prefix = fenced(() => artifactStoragePrefix(artifactId, path));
  const root = `${artifactPrefix.storageFiles(artifactId)}/`;
  const [files] = await storageAdmin()
    .bucket()
    .getFiles({ prefix, maxResults: MAX_LISTED, autoPaginate: false });
  return {
    files: files.map((f) => ({
      path: `/${f.name.slice(root.length)}`,
      size: Number(f.metadata.size ?? 0),
      contentType: f.metadata.contentType ?? null,
      updatedAt: Date.parse(String(f.metadata.updated ?? f.metadata.timeCreated ?? '')) || 0,
    })),
  };
});

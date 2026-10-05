/**
 * artifactFileDelete — db.storage.delete(path): whoever may WRITE the
 * artifact's data (owner, editor, and a viewer unless the artifact is
 * read-only for viewers), and nobody while it is archived. The same answer
 * the Storage rule gives for an upload; deletes come through here because
 * Storage rules let no client delete (storage.rules).
 *
 * Deleting a file that is not there is fine: the caller wanted it gone.
 */
import { artifactCan, artifactStorageFile, errors } from '@tm/shared';
import { fenced, loadArtifact } from '../artifacts/shared.js';
import { ports } from '../adapters/index.js';
import { defineCommand } from './_registry.js';

export default defineCommand('artifactFileDelete', async (ctx, { artifactId, path }) => {
  const { artifact, role, agentAccess } = await loadArtifact(null, artifactId, ctx, 'open');
  // App-only (no scopes), so an agent never gets here — but if it ever does,
  // its answer is its own data permission (§AA3), not the 'editor' it reads as.
  const mayWrite = agentAccess
    ? agentAccess.data === 'write'
    : artifactCan.writeData(role, artifact.readOnly);
  if (artifact.archivedAt !== null || !mayWrite)
    throw errors.forbidden(
      artifact.archivedAt !== null
        ? 'This artifact is archived — its data cannot be changed'
        : 'This artifact is read-only for viewers',
    );
  await ports().files.delete(fenced(() => artifactStorageFile(artifactId, path)));
  return { ok: true as const };
});

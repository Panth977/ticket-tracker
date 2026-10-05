/**
 * artifactFileUrl — db.storage.url(path) (docs/plan/artifacts.html §E2, §E4):
 * a short-lived link to one of the artifact's uploaded files, for anyone with
 * a role. App-only. `path` is in the artifact's OWN view ('/photos/a.png');
 * artifactStorageFile puts the prefix on and refuses anything that could step
 * outside it.
 *
 * 404 when the object is not there — a clean refusal now rather than a dead
 * URL in an <img> later.
 */
import { artifactStorageFile, errors } from '@tm/shared';
import { objectLink, objectOf } from '../artifacts/files.js';
import { fenced, loadArtifact } from '../artifacts/shared.js';
import { ports } from '../adapters/index.js';
import { defineCommand } from './_registry.js';

export default defineCommand('artifactFileUrl', async (ctx, { artifactId, path }) => {
  await loadArtifact(null, artifactId, ctx, 'open');
  const full = fenced(() => artifactStorageFile(artifactId, path));
  if (!(await ports().files.stat(full))) throw errors.not_found('File not found');
  return objectLink(artifactId, objectOf(artifactId, full), ctx.actor, ctx.now);
});

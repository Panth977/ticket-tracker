/**
 * artifactUpdate — owner only (404 to anyone without a role, 403 to editors
 * and viewers): name, description, icon, the read-only switch for viewers
 * (§B), archive / restore.
 *
 * readOnly and archived decide whether a viewer may WRITE, and the database
 * rules cannot read Firestore — so whenever either changes, the RTDB mirror
 * is rewritten after the commit (artifacts/shared.ts syncArtifactMirror).
 */
import type { Artifact } from '@tm/shared';
import { artifactRef, loadArtifact, syncArtifactMirror } from '../artifacts/shared.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

export default defineCommand('artifactUpdate', async (ctx, input) => {
  const { artifactId } = input;
  const next = await runTx(async (tx) => {
    const { artifact } = await loadArtifact(tx, artifactId, ctx, 'manage');
    const patch: Partial<Artifact> = {};
    if (input.name !== undefined && input.name !== artifact.name) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description || null;
    if (input.icon !== undefined) patch.icon = input.icon || null;
    if (input.readOnly !== undefined && input.readOnly !== artifact.readOnly)
      patch.readOnly = input.readOnly;
    if (input.archived !== undefined && input.archived !== (artifact.archivedAt !== null))
      patch.archivedAt = input.archived ? ctx.now : null;
    if (Object.keys(patch).length === 0) return null;
    patch.updatedAt = ctx.now;
    tx.update(artifactRef(artifactId), patch);
    return { ...artifact, ...patch };
  });
  if (next) await syncArtifactMirror(artifactId, next);
  return { ok: true as const };
});

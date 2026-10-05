/**
 * artifactDelete — owner only. Builds, source, files and ALL data go; the
 * document goes LAST (docs/plan/artifacts.html §G).
 *
 * "Last" must not mean "still usable meanwhile". So this command does the one
 * thing that has to be immediate, in a single write: it EMPTIES access,
 * agents and memberUids and stamps `deletingAt`. From that moment no rule
 * lets anyone read the document or touch the data (the rules read those
 * fields on every call), no command finds a role (roleFor), and the RTDB
 * mirror is dropped. The queued job (commands/artifactDeleteJob.ts) then
 * removes everything at its own pace and the document at the end — so a job
 * that fails halfway is retried against a document that still exists.
 */
import { artifactRef, loadArtifact, syncArtifactMirror } from '../artifacts/shared.js';
import { ports } from '../adapters/index.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

export default defineCommand('artifactDelete', async (ctx, { artifactId }) => {
  await runTx(async (tx) => {
    const { artifact } = await loadArtifact(tx, artifactId, ctx, 'manage');
    tx.update(artifactRef(artifactId), {
      access: {},
      memberUids: [],
      agents: {},
      archivedAt: artifact.archivedAt ?? ctx.now,
      deletingAt: ctx.now,
      updatedAt: ctx.now,
    });
  });
  await syncArtifactMirror(artifactId, null);
  await ports().queue.enqueue(
    'artifactDelete',
    { artifactId, actor: ctx.actor },
    { name: `artifactDelete-${artifactId}` },
  );
  return { ok: true as const };
});

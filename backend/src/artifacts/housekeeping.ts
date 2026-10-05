/**
 * The artifact parts of the daily housekeeping job (notify/housekeeping.ts):
 *
 *   OLD BUILDS   every publish is a new build; the newest ARTIFACT_BUILDS_KEPT
 *                are kept and the rest go — the document, its files and its
 *                source zip. NEVER the current build, however old: a rollback
 *                to build #3 followed by twenty publishes of something else
 *                must not delete what people are looking at.
 *   STALE ZIPS   uploads/{uploadId}.zip is single-use: artifactPublish
 *                deletes it. One that is a day old was uploaded and never
 *                published (a closed tab, a failed request) and is swept,
 *                like an attachment nobody attached.
 *   THE MIRROR   the RTDB copy the database rules read (artifactReaders /
 *                artifactFlags) is rewritten from the document, so a mirror
 *                write that failed after a commit heals by morning.
 *
 * One pass over the artifacts collection — a private tracker has tens of
 * them, not thousands.
 */
import {
  ARTIFACT_BUILDS_KEPT,
  ARTIFACT_UPLOAD_TTL_MS,
  artifactPrefix,
  type Artifact,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import { storageAdmin } from '../runtime/firebase.js';
import { artifactsCol, buildsCol, syncArtifactMirror } from './shared.js';

/** Drop the builds beyond the newest ARTIFACT_BUILDS_KEPT of one artifact (never the current). */
export async function pruneBuilds(
  artifactId: string,
  artifact: Pick<Artifact, 'currentBuild'>,
): Promise<number> {
  const builds = (await buildsCol(artifactId).orderBy('createdAt', 'desc').get()).docs;
  const old = builds.slice(ARTIFACT_BUILDS_KEPT).filter((b) => b.id !== artifact.currentBuild);
  for (const b of old) {
    // Files first: a build document whose files are gone is worse than the reverse.
    await ports().files.deletePrefix(`${artifactPrefix.storageBuild(artifactId, b.id)}/`);
    await ports().files.delete(artifactPrefix.storageSource(artifactId, b.id));
    await b.ref.delete();
  }
  return old.length;
}

/** Delete this artifact's upload zips older than ARTIFACT_UPLOAD_TTL_MS. */
export async function sweepUploads(artifactId: string, now: number): Promise<number> {
  const [files] = await storageAdmin()
    .bucket()
    .getFiles({ prefix: artifactPrefix.storageUploads(artifactId) });
  let n = 0;
  for (const f of files) {
    const created = Date.parse(String(f.metadata.timeCreated ?? f.metadata.updated ?? ''));
    if (!Number.isFinite(created) || now - created < ARTIFACT_UPLOAD_TTL_MS) continue;
    await f.delete({ ignoreNotFound: true });
    n++;
  }
  return n;
}

export async function artifactHousekeeping(
  now: number,
): Promise<{ buildsPruned: number; uploadsDeleted: number }> {
  const out = { buildsPruned: 0, uploadsDeleted: 0 };
  const snap = await artifactsCol().get();
  for (const d of snap.docs) {
    const artifact = d.data();
    // One being deleted belongs to its delete job; leave it alone.
    if (artifact.deletingAt) continue;
    out.buildsPruned += await pruneBuilds(d.id, artifact);
    out.uploadsDeleted += await sweepUploads(d.id, now);
    await syncArtifactMirror(d.id, artifact);
  }
  return out;
}

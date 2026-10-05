/**
 * Removing an artifact's things (docs/plan/artifacts.html §G) — run by the
 * `artifactDelete` queue (commands/artifactDeleteJob.ts), never inline: an
 * artifact's data can be any size, and a command has a request to answer.
 *
 *   purgeArtifactData   the owner's "Delete all data": every document under
 *                       db/data, every viewer's kv, the RTDB node and the
 *                       uploaded files. Builds and people are untouched.
 *   purgeArtifact       all of that, then builds, source and upload zips, the
 *                       RTDB mirrors, pending invites — and the document LAST,
 *                       so a job that dies halfway is retried against a
 *                       document that still says "being deleted".
 *
 * Idempotent: Cloud Tasks retries, and every step is a delete of whatever is
 * (still) there.
 */
import { artifactPrefix, COLLECTIONS, paths } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { inBatches } from '../commands/boardShared.js';
import { db, rtdbAdmin } from '../runtime/firebase.js';
import { artifactPath, artifactRef, buildsPath } from './shared.js';

export async function purgeArtifactData(artifactId: string): Promise<void> {
  const root = artifactPath(artifactId);
  // artifacts/{id}/db/data is a DOCUMENT with the artifact's collections under
  // it; deleting the `db` collection recursively takes all of them.
  await db().recursiveDelete(db().collection(`${root}/db`));
  await db().recursiveDelete(db().collection(`${root}/${COLLECTIONS.viewers}`));
  await rtdbAdmin().ref(artifactPrefix.rtdb(artifactId)).remove();
  await ports().files.deletePrefix(`${artifactPrefix.storageFiles(artifactId)}/`);
}

export async function purgeArtifact(artifactId: string): Promise<void> {
  await purgeArtifactData(artifactId);
  await db().recursiveDelete(db().collection(buildsPath(artifactId)));
  // builds/, source/, uploads/ — and files/ again, harmlessly.
  await ports().files.deletePrefix(artifactPrefix.storageAll(artifactId));
  const r = rtdbAdmin();
  await Promise.all([
    r.ref(artifactPrefix.rtdbReaders(artifactId)).remove(),
    r.ref(artifactPrefix.rtdbFlags(artifactId)).remove(),
  ]);
  // Invites still waiting for a sign-in would lead nowhere.
  const invites = await db()
    .collection(paths.invites())
    .where('artifactId', '==', artifactId)
    .where('status', '==', 'pending')
    .get();
  await inBatches(invites.docs, (b, d) => b.update(d.ref, { status: 'revoked' }));
  await artifactRef(artifactId).delete();
}

/**
 * artifactDataCollections — the host page's DB tab (§F): the collection ids
 * at the artifact's Firestore root (artifacts/{id}/db/data) or under one of
 * its documents, sorted. App-only: the client SDK cannot list collections,
 * and everything else the tab shows is read in the viewer's session.
 *
 * Owner and editors, as the Data section: a viewer reads what the page
 * shows them, not the shape of the whole store.
 */
import { artifactCan, artifactFirestoreDoc, artifactPrefix, errors } from '@tm/shared';
import { fenced, loadArtifact } from '../artifacts/shared.js';
import { db } from '../runtime/firebase.js';
import { defineCommand } from './_registry.js';

export default defineCommand('artifactDataCollections', async (ctx, { artifactId, path }) => {
  const { role } = await loadArtifact(null, artifactId, ctx, 'readData');
  if (!artifactCan.publish(role))
    throw errors.forbidden("Only the artifact's owner and editors can browse its data");
  // '' and '/' are the root; anything else must be one of its documents.
  const at =
    path.replace(/\//g, '') === ''
      ? artifactPrefix.firestore(artifactId)
      : fenced(() => artifactFirestoreDoc(artifactId, path));
  const cols = await db().doc(at).listCollections();
  return { collections: cols.map((c) => c.id).sort() };
});

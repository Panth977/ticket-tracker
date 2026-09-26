/** OAuth grant housekeeping shared by grantRevoke and the token endpoint. */
import { COLLECTIONS } from '@tm/shared';
import { db } from '../runtime/firebase.js';

/** Delete every oauthTokens row of one grant (access, refresh, pending codes). */
export async function revokeGrantTokens(uid: string, grantId: string): Promise<void> {
  const snap = await db().collection(COLLECTIONS.oauthTokens).where('grantId', '==', grantId).get();
  const mine = snap.docs.filter((d) => d.get('uid') === uid);
  for (let i = 0; i < mine.length; i += 400) {
    const b = db().batch();
    for (const d of mine.slice(i, i + 400)) b.delete(d.ref);
    await b.commit();
  }
}

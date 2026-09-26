/**
 * The `boardDelete` queue handler (queued by boardArchive 'delete' and by
 * accountDelete for boards where the person was alone). Lives beside the
 * board commands; autoload imports commands/, and defineTask registers it.
 *
 * Idempotent — Cloud Tasks retries, and every step tolerates a half-done
 * previous attempt:
 *   1. keys/{ticketKey} of the board's tickets → deleted: true (tombstones,
 *      never reissued); search index entries removed
 *   2. pending invites to the board → revoked
 *   3. recursive delete of boards/{boardId} and everything under it
 *   4. Storage boards/{boardId}/ prefix; the RTDB presence / typing /
 *      boardReaders mirrors and the live tree (status / rev / silence, §W)
 */
import { paths, rtdb, storage, type Ticket } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { db, rtdbAdmin } from '../runtime/firebase.js';
import { clearBoardLive } from '../platform/rtdbPaths.js';
import { defineTask } from '../runtime/functions.js';
import { allDocs, inBatches } from './boardShared.js';

export async function purgeBoard(boardId: string): Promise<void> {
  const tickets = await allDocs(db().collection(paths.tickets(boardId)));
  const search = ports().search;
  for (const t of tickets) await search.delete(t.id).catch(() => {});

  const keys = await allDocs(db().collection(paths.keys()).where('boardId', '==', boardId));
  const known = new Set(keys.map((k) => k.id));
  const tombstones = [
    ...keys.map((k) => k.ref),
    // A ticket whose keys/ doc is missing still gets its tombstone.
    ...tickets
      .map((t) => (t.data() as Ticket).key)
      .filter((k) => k && !known.has(k))
      .map((k) => db().doc(paths.key(k))),
  ];
  const byRef = new Map<string, string>(tickets.map((t) => [(t.data() as Ticket).key, t.id]));
  await inBatches(tombstones, (b, ref) =>
    b.set(
      ref,
      known.has(ref.id)
        ? { deleted: true }
        : { ticketId: byRef.get(ref.id)!, boardId, current: ref.id, deleted: true },
      { merge: true },
    ),
  );

  const invites = await db()
    .collection(paths.invites())
    .where('boardId', '==', boardId)
    .where('status', '==', 'pending')
    .get();
  await inBatches(invites.docs, (b, d) => b.update(d.ref, { status: 'revoked' }));

  await db().recursiveDelete(db().doc(paths.board(boardId)));

  await ports()
    .files.deletePrefix(storage.boardPrefix(boardId))
    .catch((e) => console.warn(`[boardDelete] storage cleanup for ${boardId} failed`, e));
  const r = rtdbAdmin();
  await Promise.all([
    r.ref(rtdb.presenceBoard(boardId)).remove(),
    r.ref(`typing/${boardId}`).remove(),
    r.ref(rtdb.boardReaders(boardId)).remove(),
    // §W: the live tree too — heartbeat status, the revision, the sweep's marks.
    clearBoardLive(boardId),
  ]);
}

defineTask('boardDelete', async ({ boardId }) => {
  await purgeBoard(boardId);
});

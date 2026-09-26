/**
 * ticketDelete (app/backend.json services.ticketDelete).
 *
 *   board.settings.allowDelete && can(delete)
 *   transaction: remove this ticket from the links of the tickets it linked
 *     and from the referencedBy of the tickets it #referenced; drop it from
 *     watchers' prefs.watching; tombstone every keys/ entry that points at it
 *     ({ deleted: true } — '#ENG-42' then says 'deleted', and the key is never
 *     reissued: the board counter only goes up); delete the ticket doc
 *   then: recursive delete of the ticket's data/ pages and the Storage prefix
 *   webhook ticket.deleted
 *
 * Tickets that #mention this one keep their text; their `refs` entry now
 * resolves to a tombstoned key.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { COLLECTIONS, errors, paths, storage, type BoardPref, type KeyIndex } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { typedDoc } from '../runtime/converters.js';
import { db } from '../runtime/firebase.js';
import { runTx, txGetAll } from '../runtime/tx.js';
import {
  loadBoard,
  loadTicket,
  requireCan,
  requireWritableBoard,
  ticketRef,
} from '../tickets/access.js';
import { afterCommit, emitSafe } from '../tickets/effects.js';
import { writerFor } from '../tickets/doc.js';
import { withoutTicket } from '../tickets/links.js';
import { locateTickets } from '../tickets/locate.js';
import { activityDoc } from '../tickets/writes.js';
import { defineCommand } from './_registry.js';

export default defineCommand('ticketDelete', async (ctx, input) => {
  const { boardId, ticketId } = input;
  const board = await loadBoard(ctx, boardId);
  if (!board.settings.allowDelete) {
    requireCan(ctx, board, 'read');
    throw errors.forbidden('Deleting tickets is turned off on this board — archive it instead');
  }
  requireCan(ctx, board, 'delete');
  requireWritableBoard(board);

  // Locate everything that points at it (outside the tx: queries + cross-board lookups).
  const pre = await loadTicket(boardId, ticketId);
  const others = await locateTickets([...pre.links.map((l) => l.ticketId), ...pre.refs], boardId);
  const keySnaps = await db().collection(COLLECTIONS.keys).where('ticketId', '==', ticketId).get();
  const keyIds = [...new Set([pre.key, ...keySnaps.docs.map((d) => d.id)])];

  const { key } = await runTx(async (tx) => {
    // ── reads ──
    const ticket = await loadTicket(boardId, ticketId, tx);
    const otherIds = [...others.keys()];
    const otherDocs = await txGetAll(
      tx,
      otherIds.map((id) => ticketRef(others.get(id)!.boardId, id)),
    );
    const prefRefs = ticket.watcherUids.map((u) => typedDoc('prefs', paths.pref(boardId, u)));
    const prefs = await txGetAll(tx, prefRefs);
    const keyRefs = keyIds.map((k) => typedDoc('keys', paths.key(k)));
    const keys = await txGetAll(tx, keyRefs);

    // ── writes ──
    otherIds.forEach((id, i) => {
      const o = otherDocs[i];
      if (!o) return;
      const where = others.get(id)!.boardId;
      const links = withoutTicket(o.links, ticketId);
      const lostLink = links.length !== o.links.length;
      const lostRef = o.referencedBy.includes(ticketId);
      if (!lostLink && !lostRef) return;
      // §W: the other ticket's links, its backlink and its activity row are
      // all fields of its one document.
      const ow = writerFor(tx, ctx, where, id, o);
      if (lostLink) ow.set({ links });
      if (lostRef) ow.set({ referencedBy: o.referencedBy.filter((r) => r !== ticketId) });
      if (lostLink)
        ow.addActivity(activityDoc(ctx, 'link', { links: { from: o.links, to: links } }));
      ow.touch();
      ow.commit();
    });
    prefs.forEach((p: BoardPref | undefined, i) => {
      if (p?.watching.includes(ticketId))
        tx.update(prefRefs[i]!, { watching: FieldValue.arrayRemove(ticketId) });
    });
    keys.forEach((k: KeyIndex | undefined, i) => {
      // Tombstone: kept forever, never reissued.
      const tomb: KeyIndex = k
        ? { ...k, deleted: true }
        : { ticketId, boardId, current: ticket.key, deleted: true };
      tx.set(keyRefs[i]!, tomb);
    });
    tx.delete(ticketRef(boardId, ticketId));
    return { key: ticket.key };
  });

  // The thread, activity and files rows, and every object under the ticket's prefix.
  await afterCommit('recursiveDelete', () =>
    db().recursiveDelete(db().doc(paths.ticket(boardId, ticketId))),
  );
  await afterCommit('storage', () =>
    ports().files.deletePrefix(storage.ticketPrefix(boardId, ticketId)),
  );
  await emitSafe(boardId, 'ticket.deleted', () => ({ id: ticketId, key }), ctx);
  return { ok: true as const };
});

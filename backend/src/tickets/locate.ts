/**
 * Where does ticket X live? Links and #references store only the IMMUTABLE
 * ticket id, but a document path needs the board. Look on the hinted board
 * first (almost always right: links live on one board), then fall back to the
 * keys/ index, whose entries carry the board.
 */
import { COLLECTIONS, paths, type KeyIndex, type Ticket } from '@tm/shared';
import { db } from '../runtime/firebase.js';

export interface TicketLocation {
  boardId: string;
  key: string;
  ticket: Ticket;
}

const chunk = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
export { chunk };

/** Locate tickets by id. Missing / deleted ones are absent from the map. */
export async function locateTickets(
  ids: readonly string[],
  hintBoardId?: string,
): Promise<Map<string, TicketLocation>> {
  const out = new Map<string, TicketLocation>();
  const want = [...new Set(ids)];
  if (!want.length) return out;

  if (hintBoardId) {
    const snaps = await db().getAll(...want.map((id) => db().doc(paths.ticket(hintBoardId, id))));
    for (const s of snaps) {
      if (s.exists) {
        const t = s.data() as Ticket;
        out.set(s.id, { boardId: hintBoardId, key: t.key, ticket: t });
      }
    }
  }

  const rest = want.filter((id) => !out.has(id));
  const boardOf = new Map<string, string>();
  for (const part of chunk(rest, 30)) {
    const q = await db().collection(COLLECTIONS.keys).where('ticketId', 'in', part).get();
    for (const d of q.docs) {
      const k = d.data() as KeyIndex;
      if (!k.deleted) boardOf.set(k.ticketId, k.boardId);
    }
  }
  const found = [...boardOf.entries()];
  if (found.length) {
    const snaps = await db().getAll(...found.map(([id, b]) => db().doc(paths.ticket(b, id))));
    snaps.forEach((s, i) => {
      if (!s.exists) return;
      const t = s.data() as Ticket;
      out.set(s.id, { boardId: found[i]![1], key: t.key, ticket: t });
    });
  }
  return out;
}

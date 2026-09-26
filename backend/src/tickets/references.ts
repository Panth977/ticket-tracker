/**
 * #references — "a reference is visible from both ends". When ticket A's
 * description or thread #mentions B, B.referencedBy gets A in the SAME
 * transaction; from a message, B's thread also gets a system line
 * 'Referenced from #ENG-40' and an activity row 'referenced'.
 *
 * Two phases because a Firestore transaction reads everything before it
 * writes: readRefTargets() in the read phase, writeReferences() after.
 *
 * Phase 15 (§W): the backlink, the system line and the activity row all land
 * in the TARGET's one document — readRefTargets already read it, so a writer
 * over it needs no extra read and the whole reference costs one write per
 * target instead of three.
 */
import { paths, type Ticket } from '@tm/shared';
import { typedDoc } from '../runtime/converters.js';
import type { ServerCtx } from '../runtime/context.js';
import type { Tx } from '../runtime/tx.js';
import { writerFor } from './doc.js';
import type { TicketLocation } from './locate.js';
import { activityDoc, richFromInline, systemMessage } from './writes.js';

export interface RefTarget {
  id: string;
  boardId: string;
  ticket: Ticket;
}

/** Re-read ref targets inside the transaction; vanished ones are dropped. */
export async function readRefTargets(
  tx: Tx,
  ids: readonly string[],
  where: Map<string, TicketLocation>,
): Promise<RefTarget[]> {
  const list = ids.filter((id) => where.has(id));
  if (!list.length) return [];
  const refs = list.map((id) => typedDoc('tickets', paths.ticket(where.get(id)!.boardId, id)));
  const snaps = await tx.getAll(...refs);
  const out: RefTarget[] = [];
  snaps.forEach((s, i) => {
    if (s.exists)
      out.push({ id: list[i]!, boardId: where.get(list[i]!)!.boardId, ticket: s.data()! });
  });
  return out;
}

export interface ReferenceSource {
  id: string;
  key: string;
  boardId: string;
}

/**
 * Write the backlink on each target. With `systemLine`, also a thread line
 * and an activity row on the target (messages: "for each NEW #ref").
 */
export function writeReferences(
  tx: Tx,
  ctx: ServerCtx,
  source: ReferenceSource,
  targets: readonly RefTarget[],
  opts: { systemLine?: { byName: string } } = {},
): void {
  for (const t of targets) {
    if (t.id === source.id) continue;
    const already = t.ticket.referencedBy.includes(source.id);
    if (already) continue;
    const w = writerFor(tx, ctx, t.boardId, t.id, t.ticket);
    w.set({ referencedBy: [...new Set([...t.ticket.referencedBy, source.id])] });
    if (opts.systemLine) {
      w.addMessage(
        ctx.ids.id(),
        systemMessage(
          ctx,
          opts.systemLine.byName,
          richFromInline([
            { type: 'text', text: 'Referenced from ' },
            { type: 'ticketRef', attrs: { ticketId: source.id, key: source.key } },
          ]),
        ),
      );
      w.addActivity(
        activityDoc(ctx, 'referenced', { referencedBy: { from: null, to: source.id } }),
      );
    }
    w.touch();
    w.commit();
  }
}

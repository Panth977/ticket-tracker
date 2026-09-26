/**
 * Ticket links are written on BOTH tickets in the same transaction:
 * 'blocks' on A is 'blockedBy' on B; 'relates' / 'duplicates' are symmetric.
 * ticketUpdate sends A's full new list; this works out what changes on
 * every other ticket.
 */
import { errors, INVERSE_LINK, type TicketLink } from '@tm/shared';

const same = (a: TicketLink, b: TicketLink) => a.type === b.type && a.ticketId === b.ticketId;

/** De-duplicate; a ticket cannot link to itself. */
export function normalizeLinks(selfId: string, links: readonly TicketLink[]): TicketLink[] {
  const out: TicketLink[] = [];
  for (const l of links) {
    if (l.ticketId === selfId)
      throw errors.invalid('A ticket cannot link to itself', { field: 'links' });
    if (!out.some((x) => same(x, l))) out.push({ type: l.type, ticketId: l.ticketId });
  }
  return out;
}

export interface LinkDelta {
  /** Inverse links to add on the other ticket. */
  add: TicketLink[];
  /** Inverse links to remove from the other ticket. */
  remove: TicketLink[];
}

/** For each OTHER ticket: which inverse links appear / disappear, given A's before → after. */
export function inverseDeltas(
  selfId: string,
  before: readonly TicketLink[],
  after: readonly TicketLink[],
): Map<string, LinkDelta> {
  const out = new Map<string, LinkDelta>();
  const at = (id: string) => {
    let d = out.get(id);
    if (!d) out.set(id, (d = { add: [], remove: [] }));
    return d;
  };
  for (const l of after)
    if (!before.some((x) => same(x, l)))
      at(l.ticketId).add.push({ type: INVERSE_LINK[l.type], ticketId: selfId });
  for (const l of before)
    if (!after.some((x) => same(x, l)))
      at(l.ticketId).remove.push({ type: INVERSE_LINK[l.type], ticketId: selfId });
  return out;
}

/** The other ticket's links after a delta. */
export function applyDelta(links: readonly TicketLink[], d: LinkDelta): TicketLink[] {
  const kept = links.filter((l) => !d.remove.some((r) => same(r, l)));
  for (const a of d.add) if (!kept.some((l) => same(l, a))) kept.push(a);
  return kept;
}

/** Remove every link pointing at `ticketId` (ticketDelete clean-up). */
export const withoutTicket = (links: readonly TicketLink[], ticketId: string): TicketLink[] =>
  links.filter((l) => l.ticketId !== ticketId);

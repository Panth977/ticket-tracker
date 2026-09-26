/**
 * OPENING A TICKET READS ITS NOTIFICATIONS.
 *
 * The bell and the thread used to disagree: reading a ticket moved my read
 * pointer (users/{uid}/reads/{ticketId}, so the card stops looking unread),
 * but the inbox rows that told me about it stayed bold — six unread
 * notifications for conversations I had just read. A notification is a
 * pointer at something; once I have looked at the thing, it has done its job.
 *
 * So while a ticket is open, every unread inbox row for THAT ticket is marked
 * read, including ones that arrive while I am looking at it (I am watching the
 * thread they are about). Rows for other tickets, and invitations — which are
 * an action, not a pointer — are left alone.
 *
 * The rows come from the bell's own `inboxUnread` store, which is shared and
 * reference-counted, so this costs no extra listener and no extra read; a
 * write shows up locally at once through Firestore's latency compensation.
 * `sent` stops the same id being written twice while that round trip is in
 * flight.
 */
import type { InboxItem } from '@tm/shared';
import type { WithId } from '$lib/stores';
import { markRead } from './actions';

/** Unread rows that point at this ticket. */
export function ticketInboxIds(
  items: readonly WithId<InboxItem>[] | undefined,
  ticketId: string | null | undefined,
): string[] {
  if (!ticketId || !items?.length) return [];
  return items.filter((i) => i.ticketId === ticketId && i.readAt === null).map((i) => i.id);
}

/** Ids already handed to markRead, so a re-render cannot write them again. */
const sent = new Set<string>();

/** Mark this ticket's unread notifications read. Returns what it wrote. */
export async function readTicketNotifications(
  uid: string | null | undefined,
  ticketId: string | null | undefined,
  items: readonly WithId<InboxItem>[] | undefined,
): Promise<string[]> {
  if (!uid) return [];
  const ids = ticketInboxIds(items, ticketId).filter((id) => !sent.has(`${uid}:${id}`));
  if (!ids.length) return [];
  for (const id of ids) sent.add(`${uid}:${id}`);
  const ok = await markRead(uid, ids);
  // A failed write must be retryable — the next snapshot still shows them unread.
  if (!ok) for (const id of ids) sent.delete(`${uid}:${id}`);
  return ids;
}

/** Tests (and sign-out) start from a clean slate. */
export function forgetSentNotifications(): void {
  sent.clear();
}

/**
 * Live inbox queries. The bell and the Inbox page both read
 *   users/{uid}/inbox where(archivedAt == null) orderBy(createdAt desc) limit(n)
 * (app/db.json › inbox; index archivedAt ASC + createdAt DESC). Same limit =
 * one shared listener.
 */
import { readable, type Readable } from 'svelte/store';
import { paths, type InboxItem } from '@tm/shared';
import { queryStore, type QueryState } from '$lib/stores/live';

export const BELL_LIMIT = 50;
export const INBOX_LIMIT = 200;

export function inboxFeed(
  uid: string | null | undefined,
  limit = INBOX_LIMIT,
): Readable<QueryState<InboxItem>> {
  return queryStore<InboxItem>(
    uid
      ? {
          path: paths.inbox(uid),
          where: [['archivedAt', '==', null]],
          orderBy: [['createdAt', 'desc']],
          limit,
        }
      : null,
  );
}

/** Date.now(), refreshed every `ms` — snoozes wake up and "3m ago" moves on. */
export function clock(ms = 30_000): Readable<number> {
  return readable(Date.now(), (set) => {
    const t = setInterval(() => set(Date.now()), ms);
    return () => clearInterval(t);
  });
}

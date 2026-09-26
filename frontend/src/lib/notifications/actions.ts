/**
 * Inbox flag writes. users/{uid}/inbox is one of the few places the client
 * writes Firestore directly (rules: owner, onlyChanges readAt / archivedAt /
 * snoozedUntil) — these are facts about MY inbox, with no invariant across
 * documents, so they skip the command layer.
 *
 * No optimistic overlay is needed: Firestore's latency compensation shows a
 * local write in every onSnapshot at once. A rejected write rolls back by
 * itself; we only tell the person.
 */
import { doc, writeBatch } from 'firebase/firestore';
import { paths, type Millis } from '@tm/shared';
import { getDb } from '$lib/firebase/client';
import { toast } from '$lib/ui/toast.svelte';

type Flags = Partial<Record<'readAt' | 'archivedAt' | 'snoozedUntil', Millis | null>>;

/** Firestore batches cap at 500 writes. */
const BATCH = 450;

export async function setFlags(
  uid: string,
  ids: readonly string[],
  flags: Flags,
  failure = 'Could not update inbox',
): Promise<boolean> {
  if (!ids.length) return true;
  try {
    const db = getDb();
    for (let i = 0; i < ids.length; i += BATCH) {
      const b = writeBatch(db);
      for (const id of ids.slice(i, i + BATCH)) b.update(doc(db, paths.inboxItem(uid, id)), flags);
      await b.commit();
    }
    return true;
  } catch (e) {
    toast.error(failure, e instanceof Error ? e.message : undefined);
    return false;
  }
}

export const markRead = (uid: string, ids: readonly string[], now = Date.now()) =>
  setFlags(uid, ids, { readAt: now });
export const markUnread = (uid: string, ids: readonly string[]) =>
  setFlags(uid, ids, { readAt: null });

/** Archive (the `e` key) with an Undo toast. */
export async function archive(
  uid: string,
  ids: readonly string[],
  now = Date.now(),
): Promise<void> {
  // Archiving implies you've seen it.
  const ok = await setFlags(uid, ids, { archivedAt: now, readAt: now }, 'Could not archive');
  if (ok)
    toast.show({
      message: ids.length > 1 ? `Archived ${ids.length}` : 'Archived',
      action: { label: 'Undo', run: () => void setFlags(uid, ids, { archivedAt: null }) },
    });
}

export async function snooze(
  uid: string,
  ids: readonly string[],
  until: Millis,
  label?: string,
): Promise<void> {
  const ok = await setFlags(uid, ids, { snoozedUntil: until }, 'Could not snooze');
  if (ok)
    toast.show({
      message: label ? `Snoozed until ${label}` : 'Snoozed',
      action: { label: 'Undo', run: () => void setFlags(uid, ids, { snoozedUntil: null }) },
    });
}

export const unsnooze = (uid: string, ids: readonly string[]) =>
  setFlags(uid, ids, { snoozedUntil: null });

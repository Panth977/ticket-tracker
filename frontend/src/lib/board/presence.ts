/**
 * Board presence (RTDB presence/{boardId}/{uid}): I'm on this board while the
 * page is open (removed onDisconnect), and who else is. Uses update(), never
 * set(), so the ticket drawer's `viewing` field (lib/ticket/presence) survives.
 */
import { onDisconnect, onValue, ref, serverTimestamp, update } from 'firebase/database';
import { readable, type Readable } from 'svelte/store';
import { rtdb } from '@tm/shared';
import { getRtdb } from '$lib/firebase/client';

const quiet = (p: Promise<unknown>) => void p.catch(() => {});

/** Mark me online on this board; returns the cleanup (marks me away). */
export function joinBoard(boardId: string, uid: string): () => void {
  try {
    const node = ref(getRtdb(), rtdb.presence(boardId, uid));
    quiet(onDisconnect(node).remove());
    const mark = () =>
      quiet(
        update(node, {
          state: document.visibilityState === 'visible' ? 'online' : 'away',
          lastChanged: serverTimestamp(),
        }),
      );
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => {
      document.removeEventListener('visibilitychange', mark);
      quiet(update(node, { state: 'away', lastChanged: serverTimestamp() }));
    };
  } catch {
    return () => {};
  }
}

/** Uids of other people online on this board right now. */
export function onlineHere(boardId: string | null, me: string | null): Readable<string[]> {
  if (!boardId) return readable([]);
  return readable<string[]>([], (set) => {
    let off = () => {};
    try {
      off = onValue(
        ref(getRtdb(), rtdb.presenceBoard(boardId)),
        (s) => {
          const val = (s.val() ?? {}) as Record<string, { state?: string }>;
          set(
            Object.entries(val)
              .filter(([u, p]) => u !== me && p?.state === 'online')
              .map(([u]) => u),
          );
        },
        () => set([]),
      );
    } catch {
      /* RTDB unavailable */
    }
    return off;
  });
}

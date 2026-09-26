/**
 * Presence and typing in the Realtime Database (decisions D11: RTDB because
 * onDisconnect() exists there).
 *
 *   presence/{boardId}/{uid}          { state, viewing: ticketId, lastChanged }
 *   typing/{boardId}/{ticketId}/{uid} { at }   shown for TYPING_TTL_MS
 *
 * Rules let a board reader read both and write only their own node.
 */
import {
  onDisconnect,
  onValue,
  ref,
  remove,
  serverTimestamp,
  set,
  update,
  type DatabaseReference,
} from 'firebase/database';
import { readable, type Readable } from 'svelte/store';
import { rtdb, TYPING_TTL_MS } from '@tm/shared';
import { getRtdb } from '$lib/firebase/client';

let offset = 0;
let offsetWatched = false;
/** Server time estimate (typing timestamps are server-stamped). */
function serverNow(): number {
  if (!offsetWatched) {
    offsetWatched = true;
    try {
      onValue(ref(getRtdb(), '.info/serverTimeOffset'), (s) => (offset = Number(s.val()) || 0));
    } catch {
      /* no RTDB: fall back to the local clock */
    }
  }
  return Date.now() + offset;
}

const quiet = (p: Promise<unknown>) => void p.catch(() => {});

/**
 * I'm looking at this ticket: presence.viewing = ticketId until the returned
 * leave() (or a disconnect, which removes the node).
 */
export function viewTicket(boardId: string, ticketId: string, uid: string): () => void {
  let node: DatabaseReference;
  try {
    node = ref(getRtdb(), rtdb.presence(boardId, uid));
  } catch {
    return () => {};
  }
  quiet(onDisconnect(node).remove());
  quiet(update(node, { state: 'online', viewing: ticketId, lastChanged: serverTimestamp() }));
  const vis = () =>
    quiet(
      update(node, {
        state: document.visibilityState === 'visible' ? 'online' : 'away',
        lastChanged: serverTimestamp(),
      }),
    );
  document.addEventListener('visibilitychange', vis);
  return () => {
    document.removeEventListener('visibilitychange', vis);
    // Only clear `viewing` if it is still this ticket (another drawer may have taken over).
    quiet(update(node, { viewing: null, lastChanged: serverTimestamp() }));
  };
}

/** Other people viewing this ticket right now (uids). */
export function viewers(
  boardId: string | null,
  ticketId: string | null,
  me: string | null,
): Readable<string[]> {
  if (!boardId || !ticketId) return readable([]);
  return readable<string[]>([], (setV) => {
    let off = () => {};
    try {
      off = onValue(
        ref(getRtdb(), rtdb.presenceBoard(boardId)),
        (s) => {
          const val = (s.val() ?? {}) as Record<string, { viewing?: string; state?: string }>;
          setV(
            Object.entries(val)
              .filter(([u, p]) => u !== me && p?.viewing === ticketId)
              .map(([u]) => u),
          );
        },
        () => setV([]),
      );
    } catch {
      /* RTDB unavailable */
    }
    return off;
  });
}

/** Who is typing in this ticket's thread (not me), refreshed every second. */
export function typers(
  boardId: string | null,
  ticketId: string | null,
  me: string | null,
): Readable<string[]> {
  if (!boardId || !ticketId) return readable([]);
  return readable<string[]>([], (setV) => {
    let raw: Record<string, { at?: number }> = {};
    const emit = () => {
      const now = serverNow();
      setV(
        Object.entries(raw)
          .filter(([u, t]) => u !== me && typeof t?.at === 'number' && now - t.at < TYPING_TTL_MS)
          .map(([u]) => u),
      );
    };
    let off = () => {};
    try {
      off = onValue(
        ref(getRtdb(), rtdb.typingTicket(boardId, ticketId)),
        (s) => {
          raw = (s.val() ?? {}) as typeof raw;
          emit();
        },
        () => setV([]),
      );
    } catch {
      /* RTDB unavailable */
    }
    const timer = setInterval(emit, 1000);
    return () => {
      clearInterval(timer);
      off();
    };
  });
}

/**
 * A throttled 'I'm typing' signal for one composer: call ping() on every
 * keystroke (writes at most every 2 s), stop() on send / blur / unmount.
 */
export function typingSignal(boardId: string, ticketId: string, uid: string) {
  let last = 0;
  let node: DatabaseReference | null = null;
  const get = () => {
    if (!node) {
      node = ref(getRtdb(), rtdb.typing(boardId, ticketId, uid));
      quiet(onDisconnect(node).remove());
    }
    return node;
  };
  return {
    ping() {
      const now = Date.now();
      if (now - last < 2000) return;
      last = now;
      try {
        quiet(set(get(), { at: serverTimestamp() }));
      } catch {
        /* ignore */
      }
    },
    stop() {
      if (!last) return;
      last = 0;
      try {
        quiet(remove(get()));
      } catch {
        /* ignore */
      }
    },
  };
}

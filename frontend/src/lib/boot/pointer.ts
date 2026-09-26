/**
 * The pointer: WHICH of the cached things to subscribe to before the server
 * answers (docs/plan/agents.html § T).
 *
 * Firestore's IndexedDB cache already holds the boards, the last board's views
 * and stages and the last ticket — what it cannot tell us synchronously is
 * which of them this person was looking at. That is all this remembers: the
 * board list (id + key), the board last opened (with its view) and the ticket
 * last opened. lib/boot/prewarm then opens exactly those listeners while the
 * router is still starting, so by the time the page mounts its stores already
 * hold the cached snapshot.
 *
 * Bounded and per account:
 *   - one key per uid, so a shared device never mixes two people up
 *   - the key carries the version, so a shape change is a cache miss and not a
 *     crash; anything unreadable is dropped rather than parsed hopefully
 *   - at most MAX_BOARDS boards, every string clipped to MAX_LEN
 *
 * §W also keeps a DELTA WATERMARK per board here (`synced`): the newest
 * `updatedAt` this device has seen on that board's tickets, and when it saw
 * it. lib/stores/delta reads it back and asks Firestore only for
 * `updatedAt > watermark`, so reopening an unchanged board costs one read
 * instead of one per card. It carries its own SYNC_VERSION, because a client
 * that changes WHAT it keeps in the cache must re-sync rather than trust a
 * watermark written by the old shape.
 */

export const POINTER_PREFIX = 'tm.pointer.v1:';
export const MAX_BOARDS = 24;
const MAX_LEN = 128;

/**
 * The shape of what a delta sync assumes is in Firestore's cache. BUMP THIS
 * whenever the client changes which documents it seeds a board from: every
 * watermark is then ignored and the next board open is a full query.
 */
export const SYNC_VERSION = 1;

/**
 * How long a watermark is trusted, measured from WHEN IT WAS WRITTEN (not from
 * the watermark itself — a board nobody has touched for a month still has a
 * perfectly good one).
 *
 * A delta cannot see a HARD DELETE: `ticketDelete` removes the document, and a
 * document that is gone appears in no `updatedAt >` query. Everything else —
 * a new ticket, an edit, an archive, a restore — bumps `updatedAt` and arrives
 * in the delta. So the watermark expires, and a board opened after that pays
 * one full query to agree with the server again.
 */
export const SYNC_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface BoardRef {
  id: string;
  key: string;
}

export interface LastBoard extends BoardRef {
  /** The saved view that was open, when there was one. */
  viewId: string | null;
}

export interface LastTicket {
  /** 'ENG-42' — the ticket key is what a URL carries. */
  key: string;
  boardKey: string | null;
}

/** One board's delta watermark: the newest `updatedAt` seen, and when. */
export interface SyncMark {
  /** max(ticket.updatedAt) this device has seen on the board. */
  at: number;
  /** When that was written — what SYNC_MAX_AGE_MS is measured against. */
  seen: number;
}

/** Per-board watermarks, versioned as a whole (see SYNC_VERSION). */
export interface SyncMarks {
  v: number;
  boards: Record<string, SyncMark>;
}

export interface Pointer {
  boards: BoardRef[];
  board: LastBoard | null;
  ticket: LastTicket | null;
  /** §W: where each board's ticket list was last synced to. */
  synced: SyncMarks;
  at: number;
}

export const EMPTY_POINTER: Pointer = {
  boards: [],
  board: null,
  ticket: null,
  synced: { v: SYNC_VERSION, boards: {} },
  at: 0,
};

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_LEN) : null;
}

function keyFor(uid: string): string {
  return POINTER_PREFIX + uid;
}

function boardRefs(v: unknown): BoardRef[] {
  if (!Array.isArray(v)) return [];
  const out: BoardRef[] = [];
  for (const row of v.slice(0, MAX_BOARDS)) {
    const r = row as Record<string, unknown> | null;
    const id = text(r?.id);
    const key = text(r?.key);
    if (id && key) out.push({ id, key });
  }
  return out;
}

/**
 * The watermarks, or an empty set — a map from a different SYNC_VERSION, or
 * anything that does not parse, is dropped rather than half-believed. At most
 * MAX_BOARDS of them, the most recently seen kept.
 */
function syncMarks(v: unknown): SyncMarks {
  const raw = v as { v?: unknown; boards?: unknown } | null;
  const empty: SyncMarks = { v: SYNC_VERSION, boards: {} };
  if (!raw || raw.v !== SYNC_VERSION || !raw.boards || typeof raw.boards !== 'object') return empty;
  const rows: [string, SyncMark][] = [];
  for (const [id, m] of Object.entries(raw.boards as Record<string, unknown>)) {
    const key = text(id);
    const row = m as { at?: unknown; seen?: unknown } | null;
    const at = typeof row?.at === 'number' && Number.isFinite(row.at) ? row.at : 0;
    const seen = typeof row?.seen === 'number' && Number.isFinite(row.seen) ? row.seen : 0;
    if (key && at > 0 && seen > 0) rows.push([key, { at, seen }]);
  }
  // Newest first, so the slice below keeps the boards this device still uses.
  rows.sort((a, b) => b[1].seen - a[1].seen || b[1].at - a[1].at);
  return { v: SYNC_VERSION, boards: Object.fromEntries(rows.slice(0, MAX_BOARDS)) };
}

/** What this account was looking at last time. Never throws. */
export function readPointer(uid: string | null | undefined): Pointer {
  if (!uid) return EMPTY_POINTER;
  const raw = store()?.getItem(keyFor(uid));
  if (!raw) return EMPTY_POINTER;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const b = v.board as Record<string, unknown> | null;
    const t = v.ticket as Record<string, unknown> | null;
    const id = text(b?.id);
    const key = text(b?.key);
    const tkey = text(t?.key);
    return {
      boards: boardRefs(v.boards),
      board: id && key ? { id, key, viewId: text(b?.viewId) } : null,
      ticket: tkey ? { key: tkey, boardKey: text(t?.boardKey) } : null,
      synced: syncMarks(v.synced),
      at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0,
    };
  } catch {
    forgetPointer(uid);
    return EMPTY_POINTER;
  }
}

function write(uid: string, p: Pointer): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(keyFor(uid), JSON.stringify(p));
  } catch {
    /* quota / private mode */
  }
}

export interface PointerPatch {
  /** Every board this account can see, as the sidebar lists them. */
  boards?: BoardRef[];
  /** The board a page actually resolved (id + key). */
  board?: BoardRef | null;
  /** The saved view open on that board, from the URL. */
  viewId?: string | null;
  /** The ticket last opened, from the URL. */
  ticket?: LastTicket | null;
  /**
   * §W: this board's ticket list is synced up to `at`. null forgets the
   * board's watermark, which makes its next open a full query.
   */
  synced?: { boardId: string; at: number | null };
}

/**
 * Merge `patch` into this account's pointer. A no-op when nothing changed, so
 * callers may hand it every snapshot without touching localStorage each time.
 * Switching board drops the remembered view: a viewId belongs to its board.
 */
export function notePointer(uid: string | null | undefined, patch: PointerPatch): Pointer {
  if (!uid) return EMPTY_POINTER;
  const prev = readPointer(uid);

  // The board: either the one being patched in, or the one we already had.
  let board: LastBoard | null = prev.board;
  if (patch.board !== undefined) {
    const id = text(patch.board?.id);
    const key = text(patch.board?.key);
    // A different board means the remembered view is not ours to keep.
    board =
      id && key ? { id, key, viewId: prev.board?.key === key ? prev.board.viewId : null } : null;
  }
  if (patch.viewId !== undefined && board) board = { ...board, viewId: text(patch.viewId) };

  let ticket: LastTicket | null = prev.ticket;
  if (patch.ticket !== undefined) {
    const key = text(patch.ticket?.key);
    ticket = key ? { key, boardKey: text(patch.ticket?.boardKey) } : null;
  }

  let synced = prev.synced;
  if (patch.synced) {
    const id = text(patch.synced.boardId);
    if (id) {
      const rest = { ...synced.boards };
      if (patch.synced.at == null || patch.synced.at <= 0) delete rest[id];
      else rest[id] = { at: patch.synced.at, seen: Date.now() };
      synced = syncMarks({ v: SYNC_VERSION, boards: rest });
    }
  }

  const next: Pointer = {
    boards: patch.boards ? boardRefs(patch.boards) : prev.boards,
    board,
    ticket,
    synced,
    at: Date.now(),
  };
  // `seen` moves on every write, so the no-op test ignores it: re-confirming
  // the same watermark must not touch localStorage on every snapshot.
  const same = (p: Pointer) => JSON.stringify({ ...p, at: 0, synced: watermarks(p) });
  if (same(prev) === same(next)) return prev;
  write(uid, next);
  return next;
}

/** Just the watermark numbers, for the 'did anything change?' comparison. */
function watermarks(p: Pointer): Record<string, number> {
  return Object.fromEntries(Object.entries(p.synced.boards).map(([id, m]) => [id, m.at]));
}

/**
 * §W — how far this board's ticket list is synced, or 0 when a full query is
 * needed (never synced, a different SYNC_VERSION, or older than
 * SYNC_MAX_AGE_MS). 0 always means 'ask the server for everything'.
 */
export function readSynced(
  uid: string | null | undefined,
  boardId: string | null | undefined,
  now = Date.now(),
): number {
  if (!uid || !boardId) return 0;
  const m = readPointer(uid).synced.boards[boardId];
  if (!m) return 0;
  return now - m.seen > SYNC_MAX_AGE_MS ? 0 : m.at;
}

/** Remember that this board's tickets are synced up to `at` (a no-op if not newer). */
export function noteSynced(
  uid: string | null | undefined,
  boardId: string | null | undefined,
  at: number,
): void {
  if (!uid || !boardId || !(at > 0)) return;
  notePointer(uid, { synced: { boardId, at } });
}

/** Force the next open of this board (or every board) to be a full query. */
export function forgetSynced(
  uid: string | null | undefined,
  boardId?: string | null | undefined,
): void {
  if (!uid) return;
  if (boardId) {
    notePointer(uid, { synced: { boardId, at: null } });
    return;
  }
  const prev = readPointer(uid);
  if (!Object.keys(prev.synced.boards).length) return;
  write(uid, { ...prev, synced: { v: SYNC_VERSION, boards: {} }, at: Date.now() });
}

/** Sign-out: this account's pointer, or (no uid) every account's. */
export function forgetPointer(uid?: string | null): void {
  const s = store();
  if (!s) return;
  try {
    if (uid) {
      s.removeItem(keyFor(uid));
      return;
    }
    // The Storage API, not Object.keys: the keys are collected first because
    // removing one re-indexes the rest.
    const mine: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(POINTER_PREFIX)) mine.push(k);
    }
    for (const k of mine) s.removeItem(k);
  } catch {
    /* ignore */
  }
}

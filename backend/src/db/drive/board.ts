/**
 * Which store holds a board's tickets — read from the board document and
 * cached briefly, because every ticket path asks.
 *
 *   board.storage = { kind: 'drive', uid, folderId, ticketsFolderId? }  → Drive (files.ts)
 *   no board.storage                                                    → the database
 *
 * A board moving between the two (boardStorageMove) has `move.state:
 * 'running'`; ticket writes are refused until it finishes (reads keep coming
 * from where the tickets still are).
 */
import { errors } from '@tm/shared';
import type { DriveApi } from '../../bucket/drive/api.js';
import type { Db } from '../types.js';
import type { DriveBoard } from './files.js';

const TTL_MS = 5_000;

interface Entry {
  at: number;
  board: DriveBoard | null;
  moving: boolean;
}
const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<Entry>>();

export function forgetBoardStorage(boardId?: string): void {
  if (boardId === undefined) cache.clear();
  else cache.delete(boardId);
}

async function load(base: Db, boardId: string): Promise<Entry> {
  const snap = await base.doc(`boards/${boardId}`).get();
  const d = snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
  const s = d?.storage as
    | { kind?: string; uid?: string; folderId?: string; ticketsFolderId?: string | null }
    | undefined;
  const board: DriveBoard | null =
    s?.kind === 'drive' && s.uid && s.folderId
      ? { boardId, uid: s.uid, folderId: s.folderId, ticketsFolderId: s.ticketsFolderId ?? null }
      : null;
  const move = d?.move as { state?: string } | undefined;
  return { at: Date.now(), board, moving: move?.state === 'running' };
}

async function entry(base: Db, boardId: string): Promise<Entry> {
  const hit = cache.get(boardId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  let p = pending.get(boardId);
  if (!p) {
    p = load(base, boardId).finally(() => pending.delete(boardId));
    pending.set(boardId, p);
  }
  const e = await p;
  cache.set(boardId, e);
  return e;
}

/** What the last read said (undefined = not read lately). Synchronous, for TicketWriter. */
export function cachedDriveBoard(boardId: string): DriveBoard | null | undefined {
  return cache.get(boardId)?.board;
}

/** The board's Drive, or null when its tickets are in the database. */
export async function driveBoardOf(base: Db, boardId: string): Promise<DriveBoard | null> {
  return (await entry(base, boardId)).board;
}

/** Ticket writes wait for a storage move to finish. */
export async function assertNotMoving(base: Db, boardId: string): Promise<void> {
  if ((await entry(base, boardId)).moving)
    throw errors.conflict('This board is moving to its new storage; try again when it is done', {
      reason: 'board_moving',
    });
}

/** Every board whose tickets are in Drive (for collection-group queries). */
let driveBoards: { at: number; ids: Promise<string[]> } | null = null;
export function driveBoardIds(base: Db): Promise<string[]> {
  if (driveBoards && Date.now() - driveBoards.at < TTL_MS) return driveBoards.ids;
  const ids = base
    .collection('boards')
    .where('storage.kind', '==', 'drive')
    .get()
    .then((s) => s.docs.map((d) => d.id))
    .catch((e) => {
      driveBoards = null;
      throw e;
    });
  driveBoards = { at: Date.now(), ids };
  return ids;
}
export function forgetDriveBoardIds(): void {
  driveBoards = null;
}

/** The Drive client of the board's owner (lazy import: no cycle through runtime/). */
export async function driveOf(b: DriveBoard): Promise<DriveApi> {
  const { driveFor } = await import('../../bucket/drive/link.js');
  return driveFor(b.uid);
}

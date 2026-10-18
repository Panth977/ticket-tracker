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

/** Kept in Drive (§L5): any entity whose document has storage.kind 'drive'. */
export type EntityKind = 'boards' | 'dictionaries' | 'buckets' | 'artifacts';
export interface DriveEntity {
  kind: EntityKind;
  id: string;
  /** Whose Drive (their connection makes every call). */
  uid: string;
  /** The entity's folder. */
  folderId: string;
}

interface Entry {
  at: number;
  drive: DriveEntity | null;
  board: DriveBoard | null;
  moving: boolean;
}
const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<Entry>>();
const ck = (kind: EntityKind, id: string) => `${kind}/${id}`;

export function forgetBoardStorage(boardId?: string): void {
  if (boardId === undefined) cache.clear();
  else cache.delete(ck('boards', boardId));
}
export function forgetEntityStorage(kind: EntityKind, id: string): void {
  cache.delete(ck(kind, id));
}

function entryOf(kind: EntityKind, id: string, d: Record<string, unknown> | undefined): Entry {
  const s = d?.storage as
    { kind?: string; uid?: string; folderId?: string; ticketsFolderId?: string | null } | undefined;
  const drive: DriveEntity | null =
    s?.kind === 'drive' && s.uid && s.folderId
      ? { kind, id, uid: s.uid, folderId: s.folderId }
      : null;
  const board: DriveBoard | null =
    kind === 'boards' && drive
      ? {
          boardId: id,
          uid: drive.uid,
          folderId: drive.folderId,
          ticketsFolderId: s?.ticketsFolderId ?? null,
        }
      : null;
  const move = d?.move as { state?: string } | undefined;
  return { at: Date.now(), drive, board, moving: move?.state === 'running' };
}

async function load(base: Db, kind: EntityKind, id: string): Promise<Entry> {
  const snap = await base.doc(`${kind}/${id}`).get();
  return entryOf(kind, id, snap.exists ? (snap.data() as Record<string, unknown>) : undefined);
}

/** The router read the entity's document anyway: remember what it says. */
export function noteEntity(
  kind: EntityKind,
  id: string,
  data: Record<string, unknown> | undefined,
): void {
  cache.set(ck(kind, id), entryOf(kind, id, data));
}

async function entityEntry(base: Db, kind: EntityKind, id: string): Promise<Entry> {
  const key = ck(kind, id);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  let p = pending.get(key);
  if (!p) {
    p = load(base, kind, id).finally(() => pending.delete(key));
    pending.set(key, p);
  }
  const e = await p;
  cache.set(key, e);
  return e;
}
const entry = (base: Db, boardId: string) => entityEntry(base, 'boards', boardId);

/** What the last read said (undefined = not read lately). Synchronous, for TicketWriter. */
export function cachedDriveBoard(boardId: string): DriveBoard | null | undefined {
  return cache.get(ck('boards', boardId))?.board;
}

/** The board's Drive, or null when its tickets are in the database. */
export async function driveBoardOf(base: Db, boardId: string): Promise<DriveBoard | null> {
  return (await entry(base, boardId)).board;
}

/** Any entity's Drive, or null when it is kept in the database. */
export async function driveEntityOf(
  base: Db,
  kind: EntityKind,
  id: string,
): Promise<DriveEntity | null> {
  return (await entityEntry(base, kind, id)).drive;
}

/** Ticket writes wait for a storage move to finish. */
export async function assertNotMoving(base: Db, boardId: string): Promise<void> {
  if ((await entry(base, boardId)).moving)
    throw errors.conflict('This board is moving to its new storage; try again when it is done', {
      reason: 'board_moving',
    });
}

/** Writes to anything an entity keeps wait for its storage move to finish. */
export async function assertEntityNotMoving(base: Db, kind: EntityKind, id: string): Promise<void> {
  if ((await entityEntry(base, kind, id)).moving)
    throw errors.conflict('This is moving to its new storage; try again when it is done', {
      reason: 'moving',
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

/** The Drive client of the owner of a board or any entity (lazy import: no cycle through runtime/). */
export async function driveOf(b: { uid: string }): Promise<DriveApi> {
  const { driveFor } = await import('../../bucket/drive/link.js');
  return driveFor(b.uid);
}

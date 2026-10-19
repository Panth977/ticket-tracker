/**
 * boards/{b}/driveRev/{t} — THE ONLY THING FIRESTORE KEEPS ABOUT A DRIVE TICKET.
 *
 *   v        moves on every committed write: what open screens listen to
 *            (the ping), and what a writer checks it read the latest of
 *   at       when v last moved (epoch ms)
 *   lease    { holder, until } while one writer is changing the files
 *   folderId, messagesId, pagesId, metaId   where the files are
 *
 * DRIVE CANNOT REFUSE A STALE WRITE, so writes take turns. A transaction
 * reads a ticket's files freely; at its end, before the database commits, it
 * takes the lease of every Drive ticket it changes (in path order: no
 * deadlock) and checks `v` is still what it read. Changed → the whole
 * transaction runs again. Unchanged → it commits, writes the files, and
 * gives the lease back with v + 1. A writer that dies leaves a lease that
 * runs out after LEASE_MS.
 */
import { errors } from '@tm/shared';
import type { Db } from '../types.js';
import type { TicketPointers } from './files.js';

export const REV_COLLECTION = 'driveRev';
const LEASE_MS = 60_000;
const WAIT_MS = 20_000;

export const revPath = (boardId: string, ticketId: string) =>
  `boards/${boardId}/${REV_COLLECTION}/${ticketId}`;

/**
 * The rev of anything else kept in Drive (§L5): an entity's own settings file
 * (`_entity`) or one of its documents (its path under the entity, '/' → '~').
 */
export const entityRevPath = (kind: string, id: string, key: string) =>
  `${kind}/${id}/${REV_COLLECTION}/${key}`;

export interface Rev {
  v: number;
  at: number;
  lease?: { holder: string; until: number } | null;
  folderId?: string | null;
  messagesId?: string | null;
  pagesId?: string | null;
  metaId?: string | null;
}

export function pointersOf(r: Rev | undefined): TicketPointers | undefined {
  return r?.folderId
    ? {
        folderId: r.folderId,
        messagesId: r.messagesId ?? null,
        pagesId: r.pagesId ?? null,
        metaId: r.metaId ?? null,
      }
    : undefined;
}

export function readRev(base: Db, boardId: string, ticketId: string): Promise<Rev | undefined> {
  return readRevAt(base, revPath(boardId, ticketId));
}
export async function readRevAt(base: Db, path: string): Promise<Rev | undefined> {
  const s = await base.doc(path).get();
  return s.exists ? (s.data() as Rev) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Take (or keep) the lease; answers the rev as it stands. Waits for another holder. */
export function acquire(
  base: Db,
  boardId: string,
  ticketId: string,
  holder: string,
): Promise<Rev | undefined> {
  return acquireAt(base, revPath(boardId, ticketId), holder);
}
export async function acquireAt(base: Db, path: string, holder: string): Promise<Rev | undefined> {
  const ref = base.doc(path);
  const deadline = Date.now() + WAIT_MS;
  for (let delay = 100; ; delay = Math.min(delay * 1.5, 1_000)) {
    const got = await base.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists ? (snap.data() as Rev) : undefined;
      const now = Date.now();
      if (cur?.lease && cur.lease.holder !== holder && cur.lease.until > now)
        return { busy: true as const };
      tx.set(
        ref,
        { v: cur?.v ?? 0, at: cur?.at ?? now, lease: { holder, until: now + LEASE_MS } },
        {
          merge: true,
        },
      );
      return { busy: false as const, rev: cur };
    });
    if (!got.busy) return got.rev;
    if (Date.now() > deadline)
      throw errors.unavailable('Someone else is saving this; try again in a moment');
    await sleep(delay);
  }
}

/** Give the lease back; `bump` moves v (a committed write: the ping) and records where the files are. */
export function release(
  base: Db,
  boardId: string,
  ticketId: string,
  holder: string,
  bump: { ptr?: TicketPointers | null; deleted?: boolean } | null,
): Promise<void> {
  return releaseAt(base, revPath(boardId, ticketId), holder, bump);
}
export async function releaseAt(
  base: Db,
  path: string,
  holder: string,
  bump: { ptr?: TicketPointers | null; deleted?: boolean } | null,
): Promise<void> {
  const ref = base.doc(path);
  await base
    .runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists ? (snap.data() as Rev) : undefined;
      if (!cur) return;
      const mine = cur.lease?.holder === holder;
      if (!bump) {
        if (mine) tx.set(ref, { lease: null }, { merge: true });
        return;
      }
      const next: Rev = {
        ...cur,
        v: (cur.v ?? 0) + 1,
        at: Date.now(),
        lease: mine ? null : (cur.lease ?? null),
      };
      if (bump.deleted) {
        next.folderId = null;
        next.messagesId = null;
        next.pagesId = null;
        next.metaId = null;
      } else if (bump.ptr) {
        next.folderId = bump.ptr.folderId;
        next.messagesId = bump.ptr.messagesId;
        next.pagesId = bump.ptr.pagesId;
        next.metaId = bump.ptr.metaId;
      }
      tx.set(ref, next);
    })
    .catch((e) => console.error(`[drive] release ${path} failed`, e));
}

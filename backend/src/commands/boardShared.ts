/**
 * Helpers shared by the board / people / invite / view commands (cmd-boards).
 * Not a command: autoload imports it like any module in commands/, and it
 * registers nothing.
 *
 *   loadBoard      read a board inside a transaction and gate it with can()
 *   deriveAccess   readerUids / editorUids from access (the only authority)
 *   syncReaders    the RTDB boardReaders mirror (RTDB rules cannot read Firestore)
 *   takeRate       per-person daily counters in RTDB rate/{bucket}/{window}
 *   profileOf      name / email / avatar for a members/ row
 *   detachPeople   take removed people off the board's active tickets
 *   deleteBoardTx  tombstone the key, drop the board doc, queue the recursive delete
 */
import { createHash } from 'node:crypto';
import { FieldValue, type DocumentReference, type Query } from 'firebase-admin/firestore';
import {
  errors,
  isAgentId,
  paths,
  rtdb,
  type Activity,
  type Board,
  type BoardMember,
  type BoardRole,
  type BoardWithId,
  type StageGrant,
  type Ticket,
  type Uid,
} from '@tm/shared';
import { can, roleOf, type Action } from '@tm/shared/logic/index';
import { ports } from '../adapters/index.js';
import type { ServerCtx } from '../runtime/context.js';
import { typedDoc } from '../runtime/converters.js';
import { auth, db, isEmulated, rtdbAdmin } from '../runtime/firebase.js';
import { txGet, type Tx } from '../runtime/tx.js';
import { batchWriter } from '../tickets/doc.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** boardCreate: 10 new boards per person per day (platform/db.json rateLimits). */
export const BOARD_CREATES_PER_DAY = 10;
/** inviteCreate: 50 invites per person per day. */
export const INVITES_PER_DAY = 50;

export const boardRef = (boardId: string) => typedDoc('boards', paths.board(boardId));
export const memberRef = (boardId: string, uid: string) =>
  typedDoc('members', paths.member(boardId, uid));

/** Where links in e-mails point (same default as notify/config.ts). */
export function appUrl(): string {
  return (
    process.env.APP_URL ?? (isEmulated() ? 'http://127.0.0.1:5190' : 'https://taskmanager.app')
  ).replace(/\/+$/, '');
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Read a board in a transaction and check `action`. Someone NOT on the board
 * gets 404 (never leak that it exists); someone on it without the right gets 403.
 */
export async function loadBoard(
  tx: Tx,
  boardId: string,
  ctx: ServerCtx,
  action: Action,
): Promise<BoardWithId> {
  const data = await txGet(tx, boardRef(boardId));
  return gate(data, boardId, ctx, action);
}

/** Same as loadBoard, outside a transaction. */
export async function loadBoardNoTx(
  boardId: string,
  ctx: ServerCtx,
  action: Action,
): Promise<BoardWithId> {
  const snap = await boardRef(boardId).get();
  return gate(snap.exists ? snap.data() : undefined, boardId, ctx, action);
}

function gate(
  data: Board | undefined,
  boardId: string,
  ctx: ServerCtx,
  action: Action,
): BoardWithId {
  if (!data) throw errors.not_found('Board not found');
  const board: BoardWithId = { ...data, id: boardId };
  // can(read) false for a narrowed token is still "not visible" → 404.
  if (!can(ctx, board, 'read')) throw errors.not_found('Board not found');
  if (!can(ctx, board, action)) throw errors.forbidden(`You cannot ${action} on this board`);
  return board;
}

/** Archived boards are read-only for everyone until restored. */
export function assertActive(board: Pick<Board, 'archivedAt'>): void {
  if (board.archivedAt !== null) throw errors.conflict('This board is archived — restore it first');
}

/**
 * readerUids / editorUids are DERIVED from access — never written independently.
 * Agents ('ag_…') hold roles in `access` but never sign in to Firebase, so they
 * are never readers: the rules and the RTDB mirror only ever see people.
 */
export function deriveAccess(access: Record<Uid, BoardRole>): {
  readerUids: Uid[];
  editorUids: Uid[];
} {
  const uids = Object.keys(access)
    .filter((u) => !isAgentId(u))
    .sort();
  return {
    readerUids: uids,
    editorUids: uids.filter((u) => access[u] === 'admin' || access[u] === 'editor'),
  };
}

export const adminCount = (access: Record<Uid, BoardRole>): number =>
  Object.values(access).filter((r) => r === 'admin').length;

/**
 * Mirror readerUids into RTDB boardReaders/{boardId} (presence / typing rules
 * read it). Written after the Firestore commit; the whole node is replaced so
 * it can never drift by more than one write.
 */
export async function syncReaders(boardId: string, readerUids: Uid[] | null): Promise<void> {
  const ref = rtdbAdmin().ref(rtdb.boardReaders(boardId));
  if (!readerUids || readerUids.length === 0) await ref.remove();
  else await ref.set(Object.fromEntries(readerUids.map((u) => [u, true])));
}

/**
 * Take `n` from a per-person daily bucket (RTDB rate/{bucket}/{day}); 429
 * with retryAfter when it would go over. Returns a refund for when the
 * command fails after taking (so a 409 does not burn the allowance).
 */
export async function takeRate(
  bucket: string,
  limit: number,
  now: number,
  n = 1,
  windowMs = DAY_MS,
): Promise<() => Promise<void>> {
  const window = Math.floor(now / windowMs);
  const ref = rtdbAdmin().ref(rtdb.rate(bucket, window));
  const res = await ref.transaction((cur: number | null) => {
    const c = typeof cur === 'number' ? cur : 0;
    if (c + n > limit) return undefined; // abort
    return c + n;
  });
  if (!res.committed) {
    const retryAfter = Math.ceil(((window + 1) * windowMs - now) / 1000);
    throw errors.rate_limited(`Limit of ${limit} per day reached — try again later`, {
      retryAfter,
      limit,
    });
  }
  return async () => {
    await ref
      .transaction((cur: number | null) => Math.max(0, (typeof cur === 'number' ? cur : 0) - n))
      .catch(() => {});
  };
}

export interface Profile {
  name: string;
  email: string;
  avatarPath: string | null;
}

/**
 * How to show a person on a board: users/{uid} when it exists, else the Auth
 * record (the onUserCreated trigger may not have run yet right after sign-up).
 */
export async function profileOf(uid: Uid): Promise<Profile> {
  const u = await typedDoc('users', paths.user(uid)).get();
  if (u.exists) {
    const d = u.data()!;
    return { name: d.name, email: d.email, avatarPath: d.avatarPath };
  }
  try {
    const rec = await auth().getUser(uid);
    const email = (rec.email ?? '').toLowerCase();
    return {
      name: (rec.displayName || email.split('@')[0] || 'Someone').slice(0, 60),
      email,
      avatarPath: null,
    };
  } catch {
    return { name: 'Someone', email: '', avatarPath: null };
  }
}

export function memberDoc(
  uid: Uid,
  role: BoardRole,
  profile: Profile,
  invitedBy: Uid | null,
  now: number,
  stageGrant: StageGrant | null = null,
): BoardMember {
  return {
    kind: 'user',
    uid,
    role,
    stageGrant: role === 'commenter' ? stageGrant : null,
    name: profile.name,
    email: profile.email,
    avatarPath: profile.avatarPath,
    invitedBy,
    joinedAt: now,
  };
}

/** Run `apply` over refs in Firestore batches of at most 400 writes. */
export async function inBatches<T>(
  items: T[],
  apply: (batch: FirebaseFirestore.WriteBatch, item: T) => void,
  size = 200,
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    const batch = db().batch();
    for (const it of items.slice(i, i + size)) apply(batch, it);
    await batch.commit();
  }
}

/** Every document of a query, paged (for board-wide sweeps). */
export async function allDocs<T>(q: Query<T>, page = 500) {
  const out: FirebaseFirestore.QueryDocumentSnapshot<T>[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot<T> | undefined;
  for (;;) {
    let qq = q.orderBy('__name__').limit(page);
    if (cursor) qq = qq.startAfter(cursor);
    const snap = await qq.get();
    out.push(...snap.docs);
    if (snap.size < page) return out;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

/**
 * A person left or was removed: take them off assigneeUids / watcherUids of
 * the board's ACTIVE tickets, each change listed in that ticket's activity.
 * Their messages stay. Runs after the access change committed (it can touch
 * many tickets, more than one transaction may hold).
 */
export async function detachPeople(boardId: string, uids: Uid[], ctx: ServerCtx): Promise<number> {
  if (uids.length === 0) return 0;
  const col = db().collection(paths.tickets(boardId));
  const hit = new Map<string, { ref: DocumentReference; t: Ticket }>();
  for (const uid of uids) {
    for (const field of ['assigneeUids', 'watcherUids'] as const) {
      const snap = await col.where(field, 'array-contains', uid).get();
      for (const d of snap.docs) hit.set(d.id, { ref: d.ref, t: d.data() as Ticket });
    }
  }
  const gone = new Set(uids);
  const work = [...hit.values()].filter(({ t }) => t.state === 'active');
  await inBatches(
    work,
    (batch, { ref, t }) => {
      const assignees = t.assigneeUids.filter((u) => !gone.has(u));
      const watchers = t.watcherUids.filter((u) => !gone.has(u));
      const changes: Activity['changes'] = {};
      if (assignees.length !== t.assigneeUids.length)
        changes.assigneeUids = { from: t.assigneeUids, to: assignees };
      if (watchers.length !== t.watcherUids.length)
        changes.watcherUids = { from: t.watcherUids, to: watchers };
      // §W: the ticket and its activity row are the same document.
      const w = batchWriter(batch, ctx, ref.parent.parent!.id, ref.id, t);
      w.set({ assigneeUids: assignees, watcherUids: watchers, updatedAt: ctx.now });
      w.addActivity({
        action: 'update',
        changes,
        actor: ctx.actor,
        via: ctx.via,
        ...(ctx.keyName ? { viaToken: ctx.keyName.slice(0, 80) } : {}),
        createdAt: ctx.now,
      });
      w.touch();
      w.commit();
    },
    400, // one write each
  );
  return work.length;
}

/**
 * A person left or was removed from a board: every token they made FOR IT
 * (as themselves or acting as one of their agents) is revoked, reason
 * 'ownerLeft' (agents.html §E).
 *
 * §R1: this deliberately does NOT touch account tokens. They carry
 * boardId: null, so the query below never matches one — and that is the
 * right answer: an account token loses THIS board (can() finds no role on
 * the very next call) without losing the boards you are still on.
 */
export async function revokeBoardTokens(uid: Uid, boardId: string, now: number): Promise<number> {
  const snap = await db().collection(paths.apiKeys(uid)).where('boardId', '==', boardId).get();
  const live = snap.docs.filter((d) => d.get('revokedAt') == null);
  await inBatches(live, (b, d) => b.update(d.ref, { revokedAt: now, revokedReason: 'ownerLeft' }));
  return live.length;
}

/**
 * Delete a board, inside the caller's transaction (after all its reads):
 * the key stays claimed as a tombstone so old #links say 'deleted', the
 * board doc goes now (so nobody can read it from this moment), and the
 * caller must run afterBoardDeleted() once the transaction commits.
 */
export function deleteBoardTx(tx: Tx, board: BoardWithId): void {
  tx.set(typedDoc('boardKeys', paths.boardKey(board.key)), { deleted: true }, { merge: true });
  tx.delete(boardRef(board.id));
}

/** After a board delete committed: drop the RTDB mirror and queue the recursive delete. */
export async function afterBoardDeleted(boardId: string, ctx: ServerCtx): Promise<void> {
  await syncReaders(boardId, null);
  await ports().queue.enqueue(
    'boardDelete',
    { boardId, actor: ctx.actor },
    { name: `boardDelete-${boardId}` },
  );
}

/** Remove a people from access + stageGrants; returns the new board fields. */
export function withoutPeople(
  board: Pick<Board, 'access' | 'stageGrants'>,
  uids: Uid[],
): Pick<Board, 'access' | 'stageGrants' | 'readerUids' | 'editorUids'> {
  const access = { ...board.access };
  const stageGrants = { ...board.stageGrants };
  for (const u of uids) {
    delete access[u];
    delete stageGrants[u];
  }
  return { access, stageGrants, ...deriveAccess(access) };
}

export { FieldValue, roleOf };

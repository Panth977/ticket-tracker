/**
 * MOVE A BOARD'S TICKETS between the database and Google Drive
 * (docs/plan/bucket.html §L4) — the board's twin of the bucket move (§K6).
 *
 *   startBoardMove      the admin, in the app: board.move = running; queue slice 0
 *   runBoardMoveSlice   the queued job: copies ticket by ticket for SLICE_MS,
 *                       then queues the next slice; the last one switches
 *                       board.storage over and clears the old copy
 *   resumeBoardMove     a stopped move picks up where it stopped
 *
 * While it runs, every ticket write on the board is refused (router.ts asks
 * board.ts) and reads keep coming from where the tickets still are. The
 * first slice waits out the board-storage cache (board.ts TTL) so no write
 * that started before the move can land behind the copy.
 *
 * EVERY SLICE IS SAFE TO REPEAT. To Drive: a ticket whose driveRev already
 * names its folder is done. To the database: a ticket document already there
 * is done. Moving to the database never deletes anything in Drive; moving to
 * Drive deletes the database's tickets only after the switch.
 */
import {
  errors,
  isAgentId,
  paths,
  type Board,
  type BoardDriveStorage,
  type BoardMove,
  type BucketStorageInput,
} from '@tm/shared';
import { ports } from '../../adapters/index.js';
import { driveEmail, driveFor } from '../../bucket/drive/link.js';
import { driveBucketFolder } from '../../bucket/drive/store.js';
import { isFolder } from '../../bucket/drive/api.js';
import type { ServerCtx } from '../../runtime/context.js';
import { baseDb, Timestamp } from '../index.js';
import { forgetBoardStorage, forgetDriveBoardIds } from './board.js';
import {
  listTickets,
  readPages,
  readTicket,
  TICKETS,
  writePage,
  writeTicket,
  type DriveBoard,
} from './files.js';
import { readRev, revPath, REV_COLLECTION } from './lease.js';
import { decodeJson, encodeJson } from './values.js';

const SLICE_MS = 6 * 60_000;
const PROGRESS_EVERY = 5;
/** Longer than board.ts's cache: no instance still believes the board is not moving. */
const SETTLE_MS = 6_000;

export const isBoardMoving = (b: Pick<Board, 'move'> | null | undefined): boolean =>
  b?.move?.state === 'running';

const boardDoc = (boardId: string) => baseDb().doc(paths.board(boardId));

async function loadAdmin(ctx: ServerCtx, boardId: string): Promise<Board> {
  if (isAgentId(ctx.actor) || ctx.keyId || ctx.via !== 'app')
    throw errors.forbidden('Move a board from the app (board settings › Storage)');
  const snap = await boardDoc(boardId).get();
  const board = snap.exists ? (snap.data() as Board) : undefined;
  if (!board || !board.readerUids?.includes(ctx.actor)) throw errors.not_found('Board not found');
  if (board.access?.[ctx.actor] !== 'admin')
    throw errors.forbidden('Only a board admin can move its tickets');
  return board;
}

const driveOfStorage = (boardId: string, s: BoardDriveStorage): DriveBoard => ({
  boardId,
  uid: s.uid,
  folderId: s.folderId,
  ticketsFolderId: s.ticketsFolderId ?? null,
});

const sliceName = (boardId: string, move: BoardMove, round: number) =>
  `boardStorageMove-${boardId}-${move.startedAt}-${move.resumes ?? 0}-${round}`;

// ─── start / resume ──────────────────────────────────────────────────────────

export async function startBoardMove(
  ctx: ServerCtx,
  boardId: string,
  to: BucketStorageInput,
): Promise<{ total: number }> {
  const board = await loadAdmin(ctx, boardId);
  if (isBoardMoving(board)) throw errors.conflict('This board is already moving');
  const from = board.storage?.kind === 'drive' ? 'drive' : 'managed';
  if (to.kind === from)
    throw errors.invalid(
      from === 'drive' ? 'Its tickets are already in Google Drive' : 'Its tickets are already in the app',
      { field: 'to' },
    );

  let target: BoardDriveStorage | null = null;
  let total: number;
  if (to.kind === 'drive') {
    const api = await driveFor(ctx.actor);
    const folder = await driveBucketFolder(api, to, board.name, ctx.actor);
    const kids = await api.children([folder.folderId]);
    const tickets =
      kids.find((k) => isFolder(k) && k.name === TICKETS)?.id ??
      (await api.createFolder(folder.folderId, TICKETS)).id;
    target = {
      kind: 'drive',
      uid: ctx.actor,
      ...folder,
      email: await driveEmail(ctx.actor),
      ticketsFolderId: tickets,
    };
    total = (await baseDb().collection(paths.tickets(boardId)).count().get()).data().count;
  } else {
    const s = board.storage!;
    total = (await listTickets(await driveFor(s.uid), driveOfStorage(boardId, s))).length;
  }

  const move: BoardMove = {
    to: to.kind,
    target,
    state: 'running',
    total,
    done: 0,
    by: ctx.actor,
    startedAt: ctx.now,
    error: null,
  };
  await boardDoc(boardId).update({ move });
  forgetBoardStorage(boardId);
  await ports().queue.enqueue('boardStorageMove', { boardId, round: 0 }, { name: sliceName(boardId, move, 0) });
  return { total };
}

export async function resumeBoardMove(ctx: ServerCtx, boardId: string): Promise<{ total: number }> {
  const board = await loadAdmin(ctx, boardId);
  const move = board.move;
  if (!move || move.state !== 'failed') throw errors.conflict('There is no stopped move to resume');
  const next: BoardMove = { ...move, state: 'running', error: null, resumes: (move.resumes ?? 0) + 1 };
  await boardDoc(boardId).update({ move: next });
  forgetBoardStorage(boardId);
  await ports().queue.enqueue('boardStorageMove', { boardId, round: 0 }, { name: sliceName(boardId, next, 0) });
  return { total: move.total };
}

// ─── the job ─────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5;

export async function runBoardMoveSlice(boardId: string, round: number, retryCount = 0): Promise<void> {
  const snap = await boardDoc(boardId).get();
  const board = snap.exists ? (snap.data() as Board) : undefined;
  if (!board || !isBoardMoving(board)) return;
  const move = board.move!;
  if (round === 0 && retryCount === 0) await new Promise((r) => setTimeout(r, SETTLE_MS));
  const deadline = Date.now() + SLICE_MS;
  let finished: boolean;
  try {
    finished =
      move.to === 'drive'
        ? await sliceToDrive(boardId, board, move, deadline)
        : await sliceToDatabase(boardId, board, move, deadline);
  } catch (e) {
    const message = (e as Error).message?.slice(0, 500) || 'The move failed';
    console.error('[drive] board move slice failed', boardId, `attempt ${retryCount + 1}`, e);
    if (retryCount + 1 < MAX_ATTEMPTS) {
      await boardDoc(boardId).update({ 'move.error': `Retrying after: ${message}` });
      throw e;
    }
    await boardDoc(boardId).update({ 'move.state': 'failed', 'move.error': message });
    forgetBoardStorage(boardId);
    return;
  }
  if (!finished)
    await ports().queue.enqueue(
      'boardStorageMove',
      { boardId, round: round + 1 },
      { name: sliceName(boardId, move, round + 1) },
    );
}

const progress = (boardId: string, done: number) => boardDoc(boardId).update({ 'move.done': done });

/** Database → Drive: each ticket's document and pages become its files; driveRev marks it done. */
async function sliceToDrive(
  boardId: string,
  board: Board,
  move: BoardMove,
  deadline: number,
): Promise<boolean> {
  const target = move.target!;
  const b = driveOfStorage(boardId, target);
  const drive = await driveFor(target.uid);
  const tickets = await baseDb().collection(paths.tickets(boardId)).get();
  let done = 0;
  for (const t of tickets.docs) {
    const rev = await readRev(baseDb(), boardId, t.id);
    if (!rev?.folderId) {
      if (Date.now() > deadline) return false;
      const doc = encodeJson(t.data()) as Record<string, unknown>;
      const ptr = await writeTicket(drive, b, t.id, null, doc);
      const pages = await baseDb().collection(paths.ticketData(boardId, t.id)).get();
      for (const p of pages.docs)
        await writePage(drive, b, t.id, p.id, encodeJson(p.data()) as Record<string, unknown>);
      await baseDb()
        .doc(revPath(boardId, t.id))
        .set({ v: 1, at: Date.now(), lease: null, ...ptr });
    }
    done++;
    if (done % PROGRESS_EVERY === 0) await progress(boardId, done);
  }
  // Every ticket is in Drive: switch, then clear the database's copy.
  await boardDoc(boardId).update({ storage: target, move: null });
  forgetBoardStorage(boardId);
  forgetDriveBoardIds();
  for (const t of tickets.docs) await baseDb().recursiveDelete(t.ref);
  return true;
}

/** Drive → database: each ticket's files become its document and pages; nothing in Drive is deleted. */
async function sliceToDatabase(
  boardId: string,
  board: Board,
  move: BoardMove,
  deadline: number,
): Promise<boolean> {
  const s = board.storage!;
  const b = driveOfStorage(boardId, s);
  const drive = await driveFor(s.uid);
  const listed = await listTickets(drive, b);
  let done = 0;
  for (const { id } of listed) {
    const ref = baseDb().doc(paths.ticket(boardId, id));
    if (!(await ref.get()).exists) {
      if (Date.now() > deadline) return false;
      const files = await readTicket(drive, b, id);
      if (files?.doc) {
        for (const p of await readPages(drive, b, id))
          await baseDb()
            .doc(paths.ticketPage(boardId, id, p.id))
            .set(decodeJson(p.doc, Timestamp) as Record<string, unknown>);
        // Written last: its existence is what marks this ticket done.
        await ref.set(decodeJson(files.doc, Timestamp) as Record<string, unknown>);
      }
    }
    done++;
    if (done % PROGRESS_EVERY === 0) await progress(boardId, done);
  }
  const { FieldValue } = await import('../index.js');
  await boardDoc(boardId).update({ storage: FieldValue.delete(), move: null });
  forgetBoardStorage(boardId);
  forgetDriveBoardIds();
  const revs = await baseDb().collection(`boards/${boardId}/${REV_COLLECTION}`).get();
  for (const r of revs.docs) await r.ref.delete();
  // Back in the database: back in the search index too.
  const { reindexTicket } = await import('../../search/sync.js');
  for (const { id } of listed)
    await reindexTicket(boardId, id, { onMissing: 'ignore' }).catch((e) =>
      console.warn('[drive] reindex after move', boardId, id, e),
    );
  return true;
}

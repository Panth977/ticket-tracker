/**
 * MOVE AN ENTITY between the database and Google Drive (docs/plan/bucket.html
 * §L4) — a board (its settings, views, templates, webhooks, integrations and
 * tickets), a dictionary (its entries) or an artifact (its settings and data
 * tabs). A bucket has its own move (bucket/drive/move.ts, §K6).
 *
 *   startEntityMove     who manages it, in the app: <kind>.move = running; queue slice 0
 *   runEntityMoveSlice  the queued job: settings and subtrees in one go, then
 *                       tickets one by one for SLICE_MS, queuing the next slice;
 *                       the last one switches `storage` over and clears the old copy
 *   resumeEntityMove    a stopped move picks up where it stopped
 *
 * While it runs every write to what the entity keeps is refused (router.ts,
 * board.ts) and reads keep coming from where it still is. The first slice
 * waits out the storage cache so no write that started before the move lands
 * behind the copy. Every slice is safe to repeat: settings and subtree files
 * are rewritten whole; a ticket whose driveRev names its folder (to Drive), or
 * whose document exists (to the database), is skipped. Moving to the database
 * never deletes anything in Drive; moving to Drive deletes the database's copy
 * only after the switch.
 */
import {
  errors,
  isAgentId,
  paths,
  type BoardDriveStorage,
  type BoardMove,
  type BucketStorageInput,
} from '@tm/shared';
import { ports } from '../../adapters/index.js';
import { isFolder } from '../../bucket/drive/api.js';
import type { DriveApi } from '../../bucket/drive/api.js';
import { driveEmail, driveFor } from '../../bucket/drive/link.js';
import { driveBucketFolder } from '../../bucket/drive/store.js';
import type { ServerCtx } from '../../runtime/context.js';
import { baseDb, FieldValue, Timestamp } from '../index.js';
import type { Db } from '../types.js';
import {
  forgetDriveBoardIds,
  forgetEntityStorage,
  type DriveEntity,
  type EntityKind,
} from './board.js';
import { childFolders, listDocFiles, readDocFile, writeDocFile } from './docfiles.js';
import { ENTITY_SPECS, entityLoc } from './entities.js';
import {
  listTickets,
  readPages,
  readTicket,
  TICKETS,
  writePage,
  writeTicket,
  type DriveBoard,
} from './files.js';
import { sealerFor } from './keyring.js';
import { readRev, revPath, REV_COLLECTION } from './lease.js';
import { refreshManifest } from './manifest.js';
import { decodeJson, encodeJson } from './values.js';

type Json = Record<string, unknown>;
export type MovableKind = Exclude<EntityKind, 'buckets'>;

const SLICE_MS = 6 * 60_000;
const PROGRESS_EVERY = 5;
/** Longer than board.ts's cache: no instance still believes it is not moving. */
const SETTLE_MS = Number(process.env.TM_DRIVE_MOVE_SETTLE_MS ?? 6_000);

interface Movable {
  name: string;
  storage?: BoardDriveStorage | null;
  move?: BoardMove | null;
  access?: Record<string, string>;
  ownerUid?: string;
}

const entityDoc = (kind: MovableKind, id: string) => baseDb().doc(`${kind}/${id}`);
const LABEL: Record<MovableKind, string> = {
  boards: 'board',
  dictionaries: 'dictionary',
  artifacts: 'artifact',
};

/** Who may move it: a board's admin; a dictionary's or an artifact's owner. In the app only. */
async function loadForMove(ctx: ServerCtx, kind: MovableKind, id: string): Promise<Movable> {
  if (isAgentId(ctx.actor) || ctx.keyId || ctx.via !== 'app')
    throw errors.forbidden(`Move a ${LABEL[kind]} from the app (its settings › Storage)`);
  const snap = await entityDoc(kind, id).get();
  const d = snap.exists ? (snap.data() as Movable) : undefined;
  const role = d?.access?.[ctx.actor];
  if (!d || !role)
    throw errors.not_found(`${LABEL[kind][0]!.toUpperCase()}${LABEL[kind].slice(1)} not found`);
  const ok = kind === 'boards' ? role === 'admin' : role === 'owner' || d.ownerUid === ctx.actor;
  if (!ok)
    throw errors.forbidden(
      kind === 'boards'
        ? 'Only a board admin can move it'
        : `Only the ${LABEL[kind]}'s owner can move it`,
    );
  return d;
}

const driveOfStorage = (kind: MovableKind, id: string, s: BoardDriveStorage): DriveEntity => ({
  kind,
  id,
  uid: s.uid,
  folderId: s.folderId,
});
const boardOf = (id: string, s: BoardDriveStorage): DriveBoard => ({
  boardId: id,
  uid: s.uid,
  folderId: s.folderId,
  ticketsFolderId: s.ticketsFolderId ?? null,
});

const sliceName = (kind: MovableKind, id: string, move: BoardMove, round: number) =>
  `entityStorageMove-${kind}-${id}-${move.startedAt}-${move.resumes ?? 0}-${round}`;

// ─── the database's subtrees, walked ─────────────────────────────────────────

/** Every document under a collection, at any depth: [path under the entity, data]. */
async function baseSubtree(
  base: Db,
  kind: MovableKind,
  id: string,
  sub: string,
): Promise<[string[], Json][]> {
  const out: [string[], Json][] = [];
  const prefix = `${kind}/${id}/`;
  async function walk(colPath: string): Promise<void> {
    for (const ref of await base.collection(colPath).listDocuments()) {
      const snap = await ref.get();
      if (snap.exists) out.push([ref.path.slice(prefix.length).split('/'), snap.data() as Json]);
      for (const c of await ref.listCollections()) if (entityLoc(`${c.path}/x`)) await walk(c.path); // a nested log (a webhook's deliveries) stays
    }
  }
  await walk(`${prefix}${sub}`);
  return out;
}

/** Every document file under a Drive subtree folder, at any depth. */
async function driveSubtree(
  drive: DriveApi,
  e: DriveEntity,
  sub: string,
  secret: boolean,
): Promise<[string[], Json][]> {
  const sealer = secret ? await sealerFor(e) : null;
  const out: [string[], Json][] = [];
  async function walkCol(rel: string[]): Promise<void> {
    for (const r of await listDocFiles(drive, e.folderId, rel, sealer))
      out.push([[...rel, r.id], r.doc]);
    for (const docId of await childFolders(drive, e.folderId, rel))
      for (const col of await childFolders(drive, e.folderId, [...rel, docId]))
        await walkCol([...rel, docId, col]);
  }
  await walkCol([sub]);
  return out;
}

// ─── start / resume ──────────────────────────────────────────────────────────

export async function startEntityMove(
  ctx: ServerCtx,
  kind: MovableKind,
  id: string,
  to: BucketStorageInput,
): Promise<{ total: number }> {
  const d = await loadForMove(ctx, kind, id);
  if (d.move?.state === 'running') throw errors.conflict(`This ${LABEL[kind]} is already moving`);
  const from = d.storage?.kind === 'drive' ? 'drive' : 'managed';
  if (to.kind === from)
    throw errors.invalid(
      from === 'drive' ? 'It is already in Google Drive' : 'It is already kept by this app',
      { field: 'to' },
    );

  let target: BoardDriveStorage | null = null;
  let total = 0;
  if (to.kind === 'drive') {
    const api = await driveFor(ctx.actor);
    const folder = await driveBucketFolder(api, to, d.name, ctx.actor);
    let ticketsFolderId: string | null = null;
    if (kind === 'boards') {
      const kids = await api.children([folder.folderId]);
      ticketsFolderId =
        kids.find((k) => isFolder(k) && k.name === TICKETS)?.id ??
        (await api.createFolder(folder.folderId, TICKETS)).id;
      total = (await baseDb().collection(paths.tickets(id)).count().get()).data().count;
    }
    target = {
      kind: 'drive',
      uid: ctx.actor,
      ...folder,
      email: await driveEmail(ctx.actor),
      ...(ticketsFolderId ? { ticketsFolderId } : {}),
    };
  } else if (kind === 'boards') {
    const s = d.storage!;
    total = (await listTickets(await driveFor(s.uid), boardOf(id, s))).length;
  }
  total += 1; // settings + subtrees, as one step

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
  await entityDoc(kind, id).update({ move });
  forgetEntityStorage(kind, id);
  await ports().queue.enqueue(
    'entityStorageMove',
    { kind, id, round: 0 },
    { name: sliceName(kind, id, move, 0) },
  );
  return { total };
}

export async function resumeEntityMove(
  ctx: ServerCtx,
  kind: MovableKind,
  id: string,
): Promise<{ total: number }> {
  const d = await loadForMove(ctx, kind, id);
  const move = d.move;
  if (!move || move.state !== 'failed') throw errors.conflict('There is no stopped move to resume');
  const next: BoardMove = {
    ...move,
    state: 'running',
    error: null,
    resumes: (move.resumes ?? 0) + 1,
  };
  await entityDoc(kind, id).update({ move: next });
  forgetEntityStorage(kind, id);
  await ports().queue.enqueue(
    'entityStorageMove',
    { kind, id, round: 0 },
    { name: sliceName(kind, id, next, 0) },
  );
  return { total: move.total };
}

// ─── the job ─────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5;

export async function runEntityMoveSlice(
  kind: MovableKind,
  id: string,
  round: number,
  retryCount = 0,
): Promise<void> {
  const snap = await entityDoc(kind, id).get();
  const d = snap.exists ? (snap.data() as Movable & Json) : undefined;
  if (!d || d.move?.state !== 'running') return;
  const move = d.move;
  if (round === 0 && retryCount === 0) await new Promise((r) => setTimeout(r, SETTLE_MS));
  const deadline = Date.now() + SLICE_MS;
  let finished: boolean;
  try {
    finished =
      move.to === 'drive'
        ? await sliceToDrive(kind, id, d, move, deadline)
        : await sliceToDatabase(kind, id, d, deadline);
  } catch (e) {
    const message = (e as Error).message?.slice(0, 500) || 'The move failed';
    console.error('[drive] entity move slice failed', kind, id, `attempt ${retryCount + 1}`, e);
    if (retryCount + 1 < MAX_ATTEMPTS) {
      await entityDoc(kind, id).update({ 'move.error': `Retrying after: ${message}` });
      throw e;
    }
    await entityDoc(kind, id).update({ 'move.state': 'failed', 'move.error': message });
    forgetEntityStorage(kind, id);
    return;
  }
  if (!finished)
    await ports().queue.enqueue(
      'entityStorageMove',
      { kind, id, round: round + 1 },
      { name: sliceName(kind, id, move, round + 1) },
    );
}

const progress = (kind: MovableKind, id: string, done: number) =>
  entityDoc(kind, id).update({ 'move.done': done });

async function sliceToDrive(
  kind: MovableKind,
  id: string,
  d: Movable & Json,
  move: BoardMove,
  deadline: number,
): Promise<boolean> {
  const base = baseDb();
  const target = move.target!;
  const e = driveOfStorage(kind, id, target);
  const drive = await driveFor(target.uid);
  const spec = ENTITY_SPECS[kind];

  // 1 · settings and subtrees: small, rewritten whole every slice.
  const settings: Json = {};
  for (const f of spec.settingsFields) if (d[f] !== undefined) settings[f] = d[f];
  if (spec.settingsFields.length)
    await writeDocFile(drive, e.folderId, [spec.settingsFile], encodeJson(settings) as Json, null);
  const subtreeDocs: Record<string, [string[], Json][]> = {};
  for (const [sub, { secret }] of Object.entries(spec.subtrees)) {
    subtreeDocs[sub] = await baseSubtree(base, kind, id, sub);
    const sealer = secret ? await sealerFor(e) : null;
    for (const [rel, data] of subtreeDocs[sub]!)
      await writeDocFile(drive, e.folderId, rel, encodeJson(data) as Json, sealer);
  }
  let done = 1;
  await progress(kind, id, done);

  // 2 · tickets (a board): one by one, skipping those already copied.
  const tickets = kind === 'boards' ? (await base.collection(paths.tickets(id)).get()).docs : [];
  if (kind === 'boards') {
    const b = boardOf(id, target);
    for (const t of tickets) {
      const rev = await readRev(base, id, t.id);
      if (!rev?.folderId) {
        if (Date.now() > deadline) return false;
        const ptr = await writeTicket(drive, b, t.id, null, encodeJson(t.data()) as Json);
        const pages = await base.collection(paths.ticketData(id, t.id)).get();
        for (const p of pages.docs)
          await writePage(drive, b, t.id, p.id, encodeJson(p.data()) as Json);
        await base.doc(revPath(id, t.id)).set({ v: 1, at: Date.now(), lease: null, ...ptr });
      }
      done++;
      if (done % PROGRESS_EVERY === 0) await progress(kind, id, done);
    }
  }

  // 3 · switch, then clear the database's copy.
  const clear: Json = { storage: target, move: null };
  for (const f of spec.settingsFields) clear[f] = FieldValue.delete();
  await entityDoc(kind, id).update(clear);
  forgetEntityStorage(kind, id);
  if (kind === 'boards') forgetDriveBoardIds();
  for (const sub of Object.keys(spec.subtrees))
    await base.recursiveDelete(base.collection(`${kind}/${id}/${sub}`));
  for (const t of tickets) await base.recursiveDelete(t.ref);
  void refreshManifest(base, e);
  return true;
}

async function sliceToDatabase(
  kind: MovableKind,
  id: string,
  d: Movable & Json,
  deadline: number,
): Promise<boolean> {
  const base = baseDb();
  const s = d.storage!;
  const e = driveOfStorage(kind, id, s);
  const drive = await driveFor(s.uid);
  const spec = ENTITY_SPECS[kind];

  // 1 · settings and subtrees.
  const back: Json = {};
  if (spec.settingsFields.length) {
    const { doc } = await readDocFile(drive, e.folderId, [spec.settingsFile], null);
    const decoded = (doc ? decodeJson(doc, Timestamp) : {}) as Json;
    for (const f of spec.settingsFields) if (decoded[f] !== undefined) back[f] = decoded[f];
  }
  for (const [sub, { secret }] of Object.entries(spec.subtrees))
    for (const [rel, data] of await driveSubtree(drive, e, sub, secret))
      await base.doc(`${kind}/${id}/${rel.join('/')}`).set(decodeJson(data, Timestamp) as Json);
  let done = 1;
  await progress(kind, id, done);

  // 2 · tickets (a board).
  const listed = kind === 'boards' ? await listTickets(drive, boardOf(id, s)) : [];
  if (kind === 'boards') {
    const b = boardOf(id, s);
    for (const { id: tid } of listed) {
      const ref = base.doc(paths.ticket(id, tid));
      if (!(await ref.get()).exists) {
        if (Date.now() > deadline) return false;
        const files = await readTicket(drive, b, tid);
        if (files?.doc) {
          for (const p of await readPages(drive, b, tid))
            await base
              .doc(paths.ticketPage(id, tid, p.id))
              .set(decodeJson(p.doc, Timestamp) as Json);
          await ref.set(decodeJson(files.doc, Timestamp) as Json);
        }
      }
      done++;
      if (done % PROGRESS_EVERY === 0) await progress(kind, id, done);
    }
  }

  // 3 · switch (settings back on the document); Drive keeps its copy.
  await entityDoc(kind, id).update({ ...back, storage: FieldValue.delete(), move: null });
  forgetEntityStorage(kind, id);
  if (kind === 'boards') {
    forgetDriveBoardIds();
    const revs = await base.collection(`boards/${id}/${REV_COLLECTION}`).get();
    for (const r of revs.docs) await r.ref.delete();
    const { reindexTicket } = await import('../../search/sync.js');
    for (const { id: tid } of listed)
      await reindexTicket(id, tid, { onMissing: 'ignore' }).catch((err) =>
        console.warn('[drive] reindex after move', id, tid, err),
      );
  } else {
    const revs = await base.collection(`${kind}/${id}/${REV_COLLECTION}`).get();
    for (const r of revs.docs) await r.ref.delete();
  }
  return true;
}

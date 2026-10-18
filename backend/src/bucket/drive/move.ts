/**
 * MOVING A BUCKET BETWEEN STORAGES (docs/plan/bucket.html §K6).
 *
 *   startMove      bucketStorageMove: owner only; finds / makes the Drive folder
 *                  for a move to Drive; stamps bucket.move { state 'running',
 *                  total, done } and queues the first slice
 *   runMoveSlice   the queued job: copies node by node for at most SLICE_MS,
 *                  then queues the next slice; the last one switches the bucket
 *                  over and cleans up behind it
 *
 * While a move runs the bucket is READ-ONLY (loadBucket refuses writes) and is
 * read from where it was: `bucket.storage` flips only at the very end, in one
 * write, so a reader never sees half a bucket.
 *
 * EVERY SLICE IS SAFE TO REPEAT. To Drive: a node already copied carries its
 * old id in the private appProperty tmNodeId and is skipped. To managed: the
 * Firestore node takes the Drive file's id, so an existing node is skipped.
 *
 * TICKET LINKS keep working both ways: managed → Drive, driveById finds an old
 * id through tmNodeId; Drive → managed, the nodes keep the Drive ids.
 *
 * THE OLD COPY. After a move to Drive the managed objects and node documents
 * are deleted (they were ours). After a move back to managed the Drive folder
 * is left exactly as it was — nothing in a person's Drive is ever deleted.
 */
import {
  bucketBaseName,
  bucketParentPath,
  bucketStoragePath,
  bucketStoragePrefix,
  errors,
  isAgentId,
  type Bucket,
  type BucketDriveStorage,
  type BucketMove,
  type BucketNode,
  type BucketStorageInput,
} from '@tm/shared';
import { ports } from '../../adapters/index.js';
import { readStream } from '../../adapters/files.js';
import { FieldValue } from '../../db/index.js';
import type { ServerCtx } from '../../runtime/context.js';
import { db } from '../../runtime/firebase.js';
import { readSubtree, type Found } from '../nodes.js';
import { bucketRef, loadBucket, nodeRef, nodesCol, nodesPath, rawBucketRef } from '../shared.js';
import type { ByteSource } from './api.js';
import { driveEmail, driveFor } from './link.js';
import {
  driveBucketFolder,
  driveMkdirp,
  driveTree,
  isDriveBucket,
  NODE_ID,
  openDrive,
} from './store.js';

/** How long one queued slice copies before handing over to the next. */
const SLICE_MS = 6 * 60_000;
/** Progress is written every this many nodes. */
const PROGRESS_EVERY = 10;

export const isMoving = (b: Pick<Bucket, 'move'> | null | undefined): boolean =>
  b?.move?.state === 'running';

export const MOVING =
  'This bucket is moving to another storage — it is read-only until the move finishes';

// ─── start ───────────────────────────────────────────────────────────────────

export async function startMove(
  ctx: ServerCtx,
  bucketId: string,
  to: BucketStorageInput,
): Promise<{ total: number }> {
  if (isAgentId(ctx.actor) || ctx.keyId || ctx.via !== 'app')
    throw errors.forbidden('Move a bucket from the app (bucket settings › Storage)');
  const { bucket } = await loadBucket(null, bucketId, ctx, 'manage');
  if (isMoving(bucket)) throw errors.conflict(MOVING);
  const from = isDriveBucket(bucket) ? 'drive' : 'managed';
  if (to.kind === from)
    throw errors.invalid(
      from === 'drive'
        ? 'This bucket is already in Google Drive'
        : 'This bucket is already managed',
      { field: 'to' },
    );

  let target: BucketDriveStorage | null = null;
  let total: number;
  if (to.kind === 'drive') {
    const api = await driveFor(ctx.actor);
    const folder = await driveBucketFolder(api, to, bucket.name, ctx.actor);
    target = { kind: 'drive', uid: ctx.actor, ...folder, email: await driveEmail(ctx.actor) };
    total = (await nodesCol(bucketId).count().get()).data().count;
  } else {
    total = (await driveTree(await openDrive(bucketId, bucket as DriveBucketDoc), '')).rows.length;
  }

  const move: BucketMove = {
    to: to.kind,
    target,
    state: 'running',
    total,
    done: 0,
    by: ctx.actor,
    startedAt: ctx.now,
    error: null,
  };
  await bucketRef(bucketId).update({ move, updatedAt: ctx.now });
  await ports().queue.enqueue(
    'bucketStorageMove',
    { bucketId, round: 0 },
    { name: `bucketStorageMove-${bucketId}-${ctx.now}-0` },
  );
  return { total };
}

type DriveBucketDoc = Bucket & { storage: BucketDriveStorage };

// ─── the job ─────────────────────────────────────────────────────────────────

export async function runMoveSlice(bucketId: string, round: number): Promise<void> {
  const bucket = (await bucketRef(bucketId).get()).data();
  if (!bucket || bucket.deletingAt || !isMoving(bucket)) return;
  const move = bucket.move!;
  const deadline = Date.now() + SLICE_MS;
  let finished: boolean;
  try {
    finished =
      move.to === 'drive'
        ? await sliceToDrive(bucketId, move, deadline)
        : await sliceToManaged(bucketId, bucket as DriveBucketDoc, deadline);
  } catch (e) {
    const message = (e as Error).message?.slice(0, 500) || 'The move failed';
    console.error('[drive] bucket move failed', bucketId, e);
    await rawBucketRef(bucketId).update({
      'move.state': 'failed',
      'move.error': message,
      updatedAt: Date.now(),
    });
    return;
  }
  if (!finished) {
    await ports().queue.enqueue(
      'bucketStorageMove',
      { bucketId, round: round + 1 },
      { name: `bucketStorageMove-${bucketId}-${move.startedAt}-${round + 1}` },
    );
  }
}

const progress = (bucketId: string, done: number) =>
  rawBucketRef(bucketId).update({ 'move.done': done });

/** Managed → Drive. Answers true when the bucket has switched over. */
async function sliceToDrive(
  bucketId: string,
  move: BucketMove,
  deadline: number,
): Promise<boolean> {
  const target = move.target;
  if (!target) throw new Error('No Drive folder to move to');
  const d = await openDrive(bucketId, { storage: target });
  // Path order puts every folder before what is in it.
  const rows = (await readSubtree(bucketId, '')).sort((a, b) =>
    a.node.path < b.node.path ? -1 : a.node.path > b.node.path ? 1 : 0,
  );
  let done = 0;
  for (const r of rows) {
    if (Date.now() > deadline) {
      await progress(bucketId, done);
      return false;
    }
    const there = await d.api.findByProp(NODE_ID, r.id);
    if (!there.length) await copyToDrive(d, r);
    done += 1;
    if (done % PROGRESS_EVERY === 0) await progress(bucketId, done);
  }
  // Switch over in one write, then remove the managed copy.
  await rawBucketRef(bucketId).update({
    storage: target,
    move: FieldValue.delete(),
    updatedAt: Date.now(),
  });
  await db().recursiveDelete(db().collection(nodesPath(bucketId)));
  await ports()
    .files.deletePrefix(bucketStoragePrefix(bucketId))
    .catch((e) => console.warn('[drive] could not delete moved objects', bucketId, e));
  return true;
}

async function copyToDrive(d: Awaited<ReturnType<typeof openDrive>>, r: Found): Promise<void> {
  const by = r.node.updatedBy;
  if (r.node.kind === 'folder') {
    const id = await driveMkdirp(d, r.node.path, by);
    await d.api.update(id, { props: { [NODE_ID]: r.id } });
    return;
  }
  const file = r.node.file;
  if (!file) return;
  const parentId = await driveMkdirp(d, bucketParentPath(r.node.path), by);
  await d.api.create({
    parentId,
    name: bucketBaseName(r.node.path),
    mime: file.mime,
    source: objectSource(file.storagePath, file.size),
    props: { tmBy: by, tmCreatedBy: r.node.createdBy, [NODE_ID]: r.id },
  });
}

/** Drive → managed. Answers true when the bucket has switched over. */
async function sliceToManaged(
  bucketId: string,
  bucket: DriveBucketDoc,
  deadline: number,
): Promise<boolean> {
  const d = await openDrive(bucketId, bucket);
  const { rows } = await driveTree(d, '');
  let done = 0;
  for (const r of rows) {
    if (Date.now() > deadline) {
      await progress(bucketId, done);
      return false;
    }
    if (!(await nodeRef(bucketId, r.id).get()).exists) await copyToManaged(d, bucketId, r);
    done += 1;
    if (done % PROGRESS_EVERY === 0) await progress(bucketId, done);
  }
  const files = rows.filter((r) => r.node.kind === 'file');
  await rawBucketRef(bucketId).update({
    storage: FieldValue.delete(),
    move: FieldValue.delete(),
    stats: {
      files: files.length,
      folders: rows.length - files.length,
      bytes: files.reduce((n, r) => n + (r.node.file?.size ?? 0), 0),
    },
    updatedAt: Date.now(),
  });
  return true;
}

async function copyToManaged(
  d: Awaited<ReturnType<typeof openDrive>>,
  bucketId: string,
  r: Found,
): Promise<void> {
  if (r.node.kind === 'folder' || !r.node.file) {
    await nodeRef(bucketId, r.id).set({ ...r.node, file: null });
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of await d.api.download(r.id)) chunks.push(Buffer.from(c as Uint8Array));
  const bytes = new Uint8Array(Buffer.concat(chunks));
  const fileId = ports().ids.id();
  const storagePath = bucketStoragePath(bucketId, fileId, encodeURIComponent(r.node.name));
  await ports().files.write(storagePath, bytes, r.node.file.mime);
  const node: BucketNode = {
    ...r.node,
    file: {
      fileId,
      storagePath,
      mime: r.node.file.mime,
      size: bytes.byteLength,
      ...(r.node.file.width && r.node.file.height
        ? { width: r.node.file.width, height: r.node.file.height }
        : {}),
    },
  };
  await nodeRef(bucketId, r.id).set(node);
}

/** Chunks of one of our objects, read by range (`end` exclusive). */
function objectSource(storagePath: string, size: number): ByteSource {
  return {
    size,
    async read(start, end) {
      if (end <= start) return new Uint8Array();
      const chunks: Buffer[] = [];
      for await (const c of readStream(storagePath, { start, end: end - 1 }))
        chunks.push(Buffer.from(c as Uint8Array));
      return new Uint8Array(Buffer.concat(chunks));
    },
  };
}

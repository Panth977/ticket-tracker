/**
 * TICKET ATTACHMENTS LIVE IN A BUCKET (docs/plan/bucket.html §J).
 *
 * A board takes no files of its own. A file put on a ticket is uploaded INTO a
 * bucket granted `write` to the board and becomes a NEW node there; the ticket
 * holds a reference (bucketRefPath + `bucket`), exactly like a bucketRefs
 * attachment (refs.ts).
 *
 *   stageBucketUploads   outside any transaction: each upload's object exists,
 *                        lies in that bucket's folder, ≤ 1 GB → its file facts
 *   planBucketUploads    the READ half, inside the command's own transaction:
 *                        the bucket is granted `write` to the board, not
 *                        archived, not deleting; '<ticketId>' filled; no
 *                        parent is a file; a taken path gets ' (2)', ' (3)'…
 *                        → the Attachments, and `write(tx)` for the write half
 *   discardUnplaced      after a FAILED command: delete the uploaded objects no
 *                        node points at (putVersion's "a failed save removes
 *                        the new object", for a batch)
 *   storeBoardFile       server-side bytes (REST / MCP upload, intake, email)
 *                        → the board's default bucket, as a BucketUpload
 *
 * WHY INSIDE THE COMMAND'S TRANSACTION: ticketCreate only knows the ticket's
 * key once it has read the board's counter in its transaction, and the path
 * may hold '<ticketId>'. Planning in that same transaction (the key is
 * ticketKey(board.key, nextNumber), read before any write) makes the ticket,
 * its key and the new bucket files ONE commit: a refused or failed create or
 * post leaves no file behind in the bucket, and never a ticket row pointing
 * at nothing. messagePost does the same, so both commands behave alike.
 *
 * Permission is the BOARD's, not the caller's bucket reach: the bucket must be
 * granted `write` to this board, and the command has already checked that the
 * caller may post there (can(comment) / can(create) / the intake door). A
 * commenter with no role on the bucket can therefore put a file into it — but
 * only a NEW file: an existing node is never replaced.
 */
import {
  attachFileName,
  DEFAULT_ATTACH_TEMPLATE,
  errors,
  fileInfo,
  fillAttachTemplate,
  fillTicketKey,
  bucketBaseName,
  bucketRefPath,
  BUCKET_UPLOAD_MAX_BYTES,
  BucketIdSchema,
  numberedPath,
  parseMemoryStoragePath,
  random6,
  splitBucketPath,
  type Attachment,
  type Board,
  type Bucket,
  type BucketFile,
  type BucketNode,
  type BucketUpload,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import type { ServerCtx } from '../runtime/context.js';
import { runTx, txGet, type Tx } from '../runtime/tx.js';
import { writeBytes } from './files.js';
import { assertRoom, bumpStats, cleanPath, folderNode, nodeAt } from './nodes.js';
import { bucketRef, nodeRef, nodesCol } from './shared.js';

const FIELD = 'bucketUploads';

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
/** How many ' (n)' names are tried before giving up. */
const MAX_NUMBERED = 500;

/** One upload whose object was found: what will become the node's `file`. */
export interface StagedUpload {
  bucketId: string;
  /** As sent: may still hold '<ticketId>'. */
  path: string;
  file: BucketFile;
  /**
   * The name the TICKET shows: the file's own name as uploaded (the object's
   * `originalName` metadata, else its object name) — not the node's templated
   * '20261005-211946_report.html', which is for the bucket.
   */
  label: string;
}

/**
 * Check each upload's object (outside any transaction — Storage is not part of
 * one). Duplicates (the same object twice) collapse to one.
 */
export async function stageBucketUploads(
  list: readonly BucketUpload[] | undefined,
): Promise<StagedUpload[]> {
  const seen = new Set<string>();
  const unique = (list ?? []).filter((u) => {
    if (seen.has(u.storagePath)) return false;
    seen.add(u.storagePath);
    return true;
  });
  const files = ports().files;
  return Promise.all(
    unique.map(async (u): Promise<StagedUpload> => {
      const p = parseMemoryStoragePath(u.storagePath);
      if (!p || p.bucketId !== u.bucketId)
        throw errors.invalid(
          "Upload under the bucket's folder: buckets/{bucketId}/{fileId}/{name}",
          { field: FIELD, storagePath: u.storagePath },
        );
      const obj = await files.stat(u.storagePath);
      if (!obj)
        throw errors.invalid('Upload not found — upload it first', {
          field: FIELD,
          storagePath: u.storagePath,
        });
      if (obj.size > BUCKET_UPLOAD_MAX_BYTES)
        throw errors.too_large('A bucket file is limited to 1 GB', { size: obj.size });
      const dim = (v: string | undefined) => {
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : undefined;
      };
      const width = dim(obj.metadata?.width);
      const height = dim(obj.metadata?.height);
      const label = attachFileName(
        obj.metadata?.originalName || safeDecode(p.fileName) || bucketBaseName(u.path),
      );
      return {
        bucketId: u.bucketId,
        path: u.path,
        label,
        file: {
          fileId: p.fileId,
          storagePath: u.storagePath,
          mime: obj.contentType || 'application/octet-stream',
          size: obj.size,
          ...(width && height ? { width, height } : {}),
        },
      };
    }),
  );
}

export interface UploadPlan {
  /** In the order staged; each is a fresh row id (callers may set their own). */
  attachments: Attachment[];
  /** The write half: folders, nodes and counters. Call after every read. */
  write(tx: Tx): void;
}

interface Planned {
  id: string;
  kind: 'file' | 'folder';
}

/** Refused unless the bucket takes new files from this board. */
function requireBoardWrite(bucket: Bucket | undefined, bucketId: string, boardId: string): Bucket {
  if (!bucket || bucket.deletingAt || bucket.boards?.[boardId] !== 'write')
    throw errors.invalid(
      "That bucket does not take this board's files — grant it write in board settings › Bucket",
      { field: FIELD, bucketId },
    );
  if (bucket.archivedAt != null)
    throw errors.conflict('That bucket is archived — restore it first', { bucketId });
  return bucket;
}

/**
 * The READ half (bucket.html §J), inside `tx`, before the caller writes
 * anything. `ticketKey` fills '<ticketId>'. An upload whose object already
 * backs a node in that bucket (a retried request) is that node again, and
 * writes nothing.
 */
export async function planBucketUploads(
  tx: Tx,
  ctx: Pick<ServerCtx, 'actor' | 'ids' | 'now'>,
  staged: readonly StagedUpload[],
  boardId: string,
  ticketKey: string,
): Promise<UploadPlan> {
  if (!staged.length) return { attachments: [], write: () => {} };
  const buckets = new Map<string, Bucket>();
  for (const id of new Set(staged.map((s) => s.bucketId)))
    buckets.set(id, requireBoardWrite(await txGet(tx, bucketRef(id)), id, boardId));

  // What this batch has already claimed, per bucket: path → node.
  const claimed = new Map<string, Map<string, Planned>>();
  const claims = (m: string) => {
    let c = claimed.get(m);
    if (!c) claimed.set(m, (c = new Map()));
    return c;
  };
  const creates: { bucketId: string; id: string; node: BucketNode }[] = [];
  const attachments: Attachment[] = [];

  for (const s of staged) {
    const { bucketId, file } = s;
    // A retry: the object is a node already (this request's first attempt).
    const backing = await tx.get(
      nodesCol(bucketId).where('file.fileId', '==', file.fileId).limit(1),
    );
    const prior = backing.docs[0];
    if (prior) {
      attachments.push(attachmentOf(ctx, bucketId, prior.id, s.label, file));
      continue;
    }
    const mine = claims(bucketId);
    const path = cleanPath(fillTicketKey(s.path, ticketKey), FIELD);
    const segs = splitBucketPath(path) ?? [];
    // Parents: a folder (made on the way when missing); never a file.
    let parentId: string | null = null;
    for (let i = 0; i < segs.length - 1; i++) {
      const p = segs.slice(0, i + 1).join('/');
      const planned = mine.get(p);
      const found = planned ? null : await nodeAt(bucketId, p, tx);
      const here = planned ?? (found ? { id: found.id, kind: found.node.kind } : null);
      if (here && here.kind !== 'folder')
        throw errors.invalid(`${p} is a file, not a folder`, { field: FIELD, path: p });
      if (here) {
        parentId = here.id;
        mine.set(p, here);
        continue;
      }
      const id = ctx.ids.id();
      creates.push({ bucketId, id, node: folderNode(ctx.actor, ctx.now, parentId, segs[i]!, p) });
      mine.set(p, { id, kind: 'folder' });
      parentId = id;
    }
    // Never replace: a taken name (file or folder) gets ' (2)', ' (3)'…
    let final: string | null = null;
    for (let n = 1; n <= MAX_NUMBERED && final === null; n++) {
      const cand = n === 1 ? path : numberedPath(path, n);
      if (mine.has(cand)) continue;
      if (await nodeAt(bucketId, cand, tx)) continue;
      final = cand;
    }
    if (final === null)
      throw errors.conflict(`Too many files named like ${path}`, { field: FIELD, path });
    const id = ctx.ids.id();
    const name = bucketBaseName(final);
    creates.push({
      bucketId,
      id,
      node: {
        kind: 'file',
        parentId,
        name,
        path: final,
        file,
        createdAt: ctx.now,
        createdBy: ctx.actor,
        updatedAt: ctx.now,
        updatedBy: ctx.actor,
      },
    });
    mine.set(final, { id, kind: 'file' });
    attachments.push(attachmentOf(ctx, bucketId, id, s.label, file));
  }

  for (const [bucketId, bucket] of buckets)
    assertRoom(bucket, creates.filter((c) => c.bucketId === bucketId).length);

  return {
    attachments,
    write(tx) {
      for (const c of creates) tx.create(nodeRef(c.bucketId, c.id), c.node);
      for (const bucketId of buckets.keys()) {
        const mine = creates.filter((c) => c.bucketId === bucketId);
        if (!mine.length) continue;
        bumpStats(
          tx,
          bucketId,
          {
            files: mine.filter((c) => c.node.kind === 'file').length,
            folders: mine.filter((c) => c.node.kind === 'folder').length,
            bytes: mine.reduce((n, c) => n + (c.node.file?.size ?? 0), 0),
          },
          ctx.now,
        );
      }
    },
  };
}

function attachmentOf(
  ctx: Pick<ServerCtx, 'actor' | 'ids'>,
  bucketId: string,
  nodeId: string,
  name: string,
  file: BucketFile,
): Attachment {
  return {
    id: ctx.ids.id(),
    path: bucketRefPath(bucketId, nodeId),
    name: name.slice(0, 255),
    mime: file.mime,
    size: file.size,
    ...(file.width && file.height ? { width: file.width, height: file.height } : {}),
    uploadedBy: ctx.actor,
    bucket: { bucketId, nodeId },
  };
}

/**
 * After a command FAILED: delete each uploaded object that no node points at
 * (it would otherwise stay in Storage for ever — nothing sweeps buckets/).
 * An object that does back a node (a retry's first attempt) is left alone.
 */
export async function discardUnplaced(
  list: readonly (StagedUpload | BucketUpload)[],
): Promise<void> {
  await Promise.all(
    list.map(async (u) => {
      const storagePath = 'file' in u ? u.file.storagePath : u.storagePath;
      const p = parseMemoryStoragePath(storagePath);
      if (!p) return;
      try {
        const q = await nodesCol(p.bucketId).where('file.fileId', '==', p.fileId).limit(1).get();
        if (q.empty) await ports().files.delete(storagePath);
      } catch (e) {
        console.warn('[bucket] could not discard an upload', storagePath, e);
      }
    }),
  );
}

/**
 * Run `fn` and, if it throws, discard the staged uploads no node points at.
 * Stage FIRST (after the command's cheap checks), then wrap the rest.
 */
export async function withUploads<T>(
  staged: readonly StagedUpload[],
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (staged.length) await discardUnplaced(staged);
    throw e;
  }
}

/**
 * bucket.html §E/§J (spec name): uploads → Attachments, each in a transaction
 * of its own. The commands plan inside their own transaction instead (see the
 * top of this file); this is for callers that have none.
 */
export async function resolveBucketUploads(
  ctx: Pick<ServerCtx, 'actor' | 'ids' | 'now'>,
  list: readonly BucketUpload[] | undefined,
  boardId: string,
  ticketKey: string,
): Promise<Attachment[]> {
  const staged = await stageBucketUploads(list);
  return withUploads(staged, () =>
    runTx(async (tx) => {
      const plan = await planBucketUploads(tx, ctx, staged, boardId, ticketKey);
      plan.write(tx);
      return plan.attachments;
    }),
  );
}

export const NO_ATTACH_BUCKET =
  'This board has no attachment bucket — set one in board settings › Bucket';

/** Where a server-side file goes: a bucket id and an explicit path (both optional). */
export interface BoardFileTarget {
  bucketId?: string | undefined;
  path?: string | undefined;
}

/**
 * Bytes the SERVER holds (REST / MCP upload, intake widget, inbound email) →
 * an object in the board's bucket, and the BucketUpload that names it. Not
 * registered yet: pass it to ticketCreate / messagePost `bucketUploads`, or
 * plan it in your own transaction. The bucket is `target.bucketId`, else the
 * board's attachBucket (none → 400). The path is `target.path`, else the
 * board's template (or the default) filled now — with ticketKey null,
 * '<ticketId>' stays for the command to fill.
 */
export async function storeBoardFile(
  ctx: Pick<ServerCtx, 'ids' | 'now'>,
  board: Pick<Board, 'attachBucket'> & { id: string },
  ticketKey: string | null,
  input: { name: string; mime?: string | null | undefined; bytes: Uint8Array },
  target: BoardFileTarget = {},
): Promise<BucketUpload> {
  const def = board.attachBucket ?? null;
  const bucketId = target.bucketId ?? def?.bucketId;
  if (!bucketId) throw errors.invalid(NO_ATTACH_BUCKET, { field: 'bucket_id' });
  if (!BucketIdSchema.safeParse(bucketId).success)
    throw errors.invalid('Not a bucket id', { field: 'bucket_id' });
  // Refuse before any byte is written (the command checks again, in its transaction).
  requireBoardWrite((await bucketRef(bucketId).get()).data(), bucketId, board.id);
  const name = attachFileName(input.name);
  let path: string;
  if (target.path !== undefined) {
    path = ticketKey ? fillTicketKey(target.path, ticketKey) : target.path;
  } else {
    const template = def && def.bucketId === bucketId ? def.template : DEFAULT_ATTACH_TEMPLATE;
    const filled = fillAttachTemplate(template, {
      ticketKey,
      at: ctx.now,
      random6: random6(),
      filename: name,
    });
    if (!filled)
      throw errors.invalid("The board's attachment path can't be used", { field: 'path' });
    path = filled.path;
  }
  // Check the path now (with a stand-in key) so a bad one never writes bytes.
  cleanPath(fillTicketKey(path, ticketKey ?? 'KEY-1'), 'path');
  const mime = input.mime?.trim() || fileInfo(null, name).mime || null;
  // writeBytes enforces its own limit; the doors have checked theirs already.
  // The OBJECT is named after the file as uploaded: that is the label the ticket
  // shows (stageBucketUploads); the node gets the templated name.
  const file = await writeBytes(
    ctx,
    bucketId,
    name,
    input.bytes,
    mime,
    BUCKET_UPLOAD_MAX_BYTES,
  );
  return { bucketId, path, storagePath: file.storagePath };
}

/** A short note for a body whose files could not be kept (intake / email without a bucket). */
export function unsavedNote(n: number): string {
  return `_(${n} attachment${n === 1 ? ' was' : 's were'} not saved: this board has no attachment bucket — board settings › Bucket)_`;
}

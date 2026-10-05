/**
 * TICKET ATTACHMENTS LIVE IN A MEMORY (docs/plan/memory.html §J).
 *
 * A board takes no files of its own. A file put on a ticket is uploaded INTO a
 * memory granted `write` to the board and becomes a NEW node there; the ticket
 * holds a reference (memoryRefPath + `memory`), exactly like a memoryRefs
 * attachment (refs.ts).
 *
 *   stageMemoryUploads   outside any transaction: each upload's object exists,
 *                        lies in that memory's folder, ≤ 1 GB → its file facts
 *   planMemoryUploads    the READ half, inside the command's own transaction:
 *                        the memory is granted `write` to the board, not
 *                        archived, not deleting; '<ticketId>' filled; no
 *                        parent is a file; a taken path gets ' (2)', ' (3)'…
 *                        → the Attachments, and `write(tx)` for the write half
 *   discardUnplaced      after a FAILED command: delete the uploaded objects no
 *                        node points at (putVersion's "a failed save removes
 *                        the new object", for a batch)
 *   storeBoardFile       server-side bytes (REST / MCP upload, intake, email)
 *                        → the board's default memory, as a MemoryUpload
 *
 * WHY INSIDE THE COMMAND'S TRANSACTION: ticketCreate only knows the ticket's
 * key once it has read the board's counter in its transaction, and the path
 * may hold '<ticketId>'. Planning in that same transaction (the key is
 * ticketKey(board.key, nextNumber), read before any write) makes the ticket,
 * its key and the new memory files ONE commit: a refused or failed create or
 * post leaves no file behind in the memory, and never a ticket row pointing
 * at nothing. messagePost does the same, so both commands behave alike.
 *
 * Permission is the BOARD's, not the caller's memory reach: the memory must be
 * granted `write` to this board, and the command has already checked that the
 * caller may post there (can(comment) / can(create) / the intake door). A
 * commenter with no role on the memory can therefore put a file into it — but
 * only a NEW file: an existing node is never replaced.
 */
import {
  attachFileName,
  DEFAULT_ATTACH_TEMPLATE,
  errors,
  fileInfo,
  fillAttachTemplate,
  fillTicketKey,
  memoryBaseName,
  memoryRefPath,
  MEMORY_UPLOAD_MAX_BYTES,
  MemoryIdSchema,
  numberedPath,
  parseMemoryStoragePath,
  random6,
  splitMemoryPath,
  type Attachment,
  type Board,
  type Memory,
  type MemoryFile,
  type MemoryNode,
  type MemoryUpload,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import type { ServerCtx } from '../runtime/context.js';
import { runTx, txGet, type Tx } from '../runtime/tx.js';
import { writeBytes } from './files.js';
import { assertRoom, bumpStats, cleanPath, folderNode, nodeAt } from './nodes.js';
import { memoryRef, nodeRef, nodesCol } from './shared.js';

const FIELD = 'memoryUploads';

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
  memoryId: string;
  /** As sent: may still hold '<ticketId>'. */
  path: string;
  file: MemoryFile;
  /**
   * The name the TICKET shows: the file's own name as uploaded (the object's
   * `originalName` metadata, else its object name) — not the node's templated
   * '20261005-211946_report.html', which is for the memory.
   */
  label: string;
}

/**
 * Check each upload's object (outside any transaction — Storage is not part of
 * one). Duplicates (the same object twice) collapse to one.
 */
export async function stageMemoryUploads(
  list: readonly MemoryUpload[] | undefined,
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
      if (!p || p.memoryId !== u.memoryId)
        throw errors.invalid(
          "Upload under the memory's folder: memories/{memoryId}/{fileId}/{name}",
          { field: FIELD, storagePath: u.storagePath },
        );
      const obj = await files.stat(u.storagePath);
      if (!obj)
        throw errors.invalid('Upload not found — upload it first', {
          field: FIELD,
          storagePath: u.storagePath,
        });
      if (obj.size > MEMORY_UPLOAD_MAX_BYTES)
        throw errors.too_large('A memory file is limited to 1 GB', { size: obj.size });
      const dim = (v: string | undefined) => {
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : undefined;
      };
      const width = dim(obj.metadata?.width);
      const height = dim(obj.metadata?.height);
      const label = attachFileName(
        obj.metadata?.originalName || safeDecode(p.fileName) || memoryBaseName(u.path),
      );
      return {
        memoryId: u.memoryId,
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

/** Refused unless the memory takes new files from this board. */
function requireBoardWrite(memory: Memory | undefined, memoryId: string, boardId: string): Memory {
  if (!memory || memory.deletingAt || memory.boards?.[boardId] !== 'write')
    throw errors.invalid(
      "That memory does not take this board's files — grant it write in board settings › Memory",
      { field: FIELD, memoryId },
    );
  if (memory.archivedAt != null)
    throw errors.conflict('That memory is archived — restore it first', { memoryId });
  return memory;
}

/**
 * The READ half (memory.html §J), inside `tx`, before the caller writes
 * anything. `ticketKey` fills '<ticketId>'. An upload whose object already
 * backs a node in that memory (a retried request) is that node again, and
 * writes nothing.
 */
export async function planMemoryUploads(
  tx: Tx,
  ctx: Pick<ServerCtx, 'actor' | 'ids' | 'now'>,
  staged: readonly StagedUpload[],
  boardId: string,
  ticketKey: string,
): Promise<UploadPlan> {
  if (!staged.length) return { attachments: [], write: () => {} };
  const memories = new Map<string, Memory>();
  for (const id of new Set(staged.map((s) => s.memoryId)))
    memories.set(id, requireBoardWrite(await txGet(tx, memoryRef(id)), id, boardId));

  // What this batch has already claimed, per memory: path → node.
  const claimed = new Map<string, Map<string, Planned>>();
  const claims = (m: string) => {
    let c = claimed.get(m);
    if (!c) claimed.set(m, (c = new Map()));
    return c;
  };
  const creates: { memoryId: string; id: string; node: MemoryNode }[] = [];
  const attachments: Attachment[] = [];

  for (const s of staged) {
    const { memoryId, file } = s;
    // A retry: the object is a node already (this request's first attempt).
    const backing = await tx.get(
      nodesCol(memoryId).where('file.fileId', '==', file.fileId).limit(1),
    );
    const prior = backing.docs[0];
    if (prior) {
      attachments.push(attachmentOf(ctx, memoryId, prior.id, s.label, file));
      continue;
    }
    const mine = claims(memoryId);
    const path = cleanPath(fillTicketKey(s.path, ticketKey), FIELD);
    const segs = splitMemoryPath(path) ?? [];
    // Parents: a folder (made on the way when missing); never a file.
    let parentId: string | null = null;
    for (let i = 0; i < segs.length - 1; i++) {
      const p = segs.slice(0, i + 1).join('/');
      const planned = mine.get(p);
      const found = planned ? null : await nodeAt(memoryId, p, tx);
      const here = planned ?? (found ? { id: found.id, kind: found.node.kind } : null);
      if (here && here.kind !== 'folder')
        throw errors.invalid(`${p} is a file, not a folder`, { field: FIELD, path: p });
      if (here) {
        parentId = here.id;
        mine.set(p, here);
        continue;
      }
      const id = ctx.ids.id();
      creates.push({ memoryId, id, node: folderNode(ctx.actor, ctx.now, parentId, segs[i]!, p) });
      mine.set(p, { id, kind: 'folder' });
      parentId = id;
    }
    // Never replace: a taken name (file or folder) gets ' (2)', ' (3)'…
    let final: string | null = null;
    for (let n = 1; n <= MAX_NUMBERED && final === null; n++) {
      const cand = n === 1 ? path : numberedPath(path, n);
      if (mine.has(cand)) continue;
      if (await nodeAt(memoryId, cand, tx)) continue;
      final = cand;
    }
    if (final === null)
      throw errors.conflict(`Too many files named like ${path}`, { field: FIELD, path });
    const id = ctx.ids.id();
    const name = memoryBaseName(final);
    creates.push({
      memoryId,
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
    attachments.push(attachmentOf(ctx, memoryId, id, s.label, file));
  }

  for (const [memoryId, memory] of memories)
    assertRoom(memory, creates.filter((c) => c.memoryId === memoryId).length);

  return {
    attachments,
    write(tx) {
      for (const c of creates) tx.create(nodeRef(c.memoryId, c.id), c.node);
      for (const memoryId of memories.keys()) {
        const mine = creates.filter((c) => c.memoryId === memoryId);
        if (!mine.length) continue;
        bumpStats(
          tx,
          memoryId,
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
  memoryId: string,
  nodeId: string,
  name: string,
  file: MemoryFile,
): Attachment {
  return {
    id: ctx.ids.id(),
    path: memoryRefPath(memoryId, nodeId),
    name: name.slice(0, 255),
    mime: file.mime,
    size: file.size,
    ...(file.width && file.height ? { width: file.width, height: file.height } : {}),
    uploadedBy: ctx.actor,
    memory: { memoryId, nodeId },
  };
}

/**
 * After a command FAILED: delete each uploaded object that no node points at
 * (it would otherwise stay in Storage for ever — nothing sweeps memories/).
 * An object that does back a node (a retry's first attempt) is left alone.
 */
export async function discardUnplaced(
  list: readonly (StagedUpload | MemoryUpload)[],
): Promise<void> {
  await Promise.all(
    list.map(async (u) => {
      const storagePath = 'file' in u ? u.file.storagePath : u.storagePath;
      const p = parseMemoryStoragePath(storagePath);
      if (!p) return;
      try {
        const q = await nodesCol(p.memoryId).where('file.fileId', '==', p.fileId).limit(1).get();
        if (q.empty) await ports().files.delete(storagePath);
      } catch (e) {
        console.warn('[memory] could not discard an upload', storagePath, e);
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
 * memory.html §E/§J (spec name): uploads → Attachments, each in a transaction
 * of its own. The commands plan inside their own transaction instead (see the
 * top of this file); this is for callers that have none.
 */
export async function resolveMemoryUploads(
  ctx: Pick<ServerCtx, 'actor' | 'ids' | 'now'>,
  list: readonly MemoryUpload[] | undefined,
  boardId: string,
  ticketKey: string,
): Promise<Attachment[]> {
  const staged = await stageMemoryUploads(list);
  return withUploads(staged, () =>
    runTx(async (tx) => {
      const plan = await planMemoryUploads(tx, ctx, staged, boardId, ticketKey);
      plan.write(tx);
      return plan.attachments;
    }),
  );
}

export const NO_ATTACH_MEMORY =
  'This board has no attachment memory — set one in board settings › Memory';

/** Where a server-side file goes: a memory id and an explicit path (both optional). */
export interface BoardFileTarget {
  memoryId?: string | undefined;
  path?: string | undefined;
}

/**
 * Bytes the SERVER holds (REST / MCP upload, intake widget, inbound email) →
 * an object in the board's memory, and the MemoryUpload that names it. Not
 * registered yet: pass it to ticketCreate / messagePost `memoryUploads`, or
 * plan it in your own transaction. The memory is `target.memoryId`, else the
 * board's attachMemory (none → 400). The path is `target.path`, else the
 * board's template (or the default) filled now — with ticketKey null,
 * '<ticketId>' stays for the command to fill.
 */
export async function storeBoardFile(
  ctx: Pick<ServerCtx, 'ids' | 'now'>,
  board: Pick<Board, 'attachMemory'> & { id: string },
  ticketKey: string | null,
  input: { name: string; mime?: string | null | undefined; bytes: Uint8Array },
  target: BoardFileTarget = {},
): Promise<MemoryUpload> {
  const def = board.attachMemory ?? null;
  const memoryId = target.memoryId ?? def?.memoryId;
  if (!memoryId) throw errors.invalid(NO_ATTACH_MEMORY, { field: 'memory_id' });
  if (!MemoryIdSchema.safeParse(memoryId).success)
    throw errors.invalid('Not a memory id', { field: 'memory_id' });
  // Refuse before any byte is written (the command checks again, in its transaction).
  requireBoardWrite((await memoryRef(memoryId).get()).data(), memoryId, board.id);
  const name = attachFileName(input.name);
  let path: string;
  if (target.path !== undefined) {
    path = ticketKey ? fillTicketKey(target.path, ticketKey) : target.path;
  } else {
    const template = def && def.memoryId === memoryId ? def.template : DEFAULT_ATTACH_TEMPLATE;
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
  // shows (stageMemoryUploads); the node gets the templated name.
  const file = await writeBytes(
    ctx,
    memoryId,
    name,
    input.bytes,
    mime,
    MEMORY_UPLOAD_MAX_BYTES,
  );
  return { memoryId, path, storagePath: file.storagePath };
}

/** A short note for a body whose files could not be kept (intake / email without a memory). */
export function unsavedNote(n: number): string {
  return `_(${n} attachment${n === 1 ? ' was' : 's were'} not saved: this board has no attachment memory — board settings › Memory)_`;
}

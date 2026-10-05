/**
 * Files that arrive through the API (docs/plan/agents.html §F, §G):
 *
 *   storeUploadedFile   POST /v1/tickets/{KEY}/files and MCP upload_file: the
 *                       server writes the blob INTO a memory granted `write` to
 *                       the board (memory.html §J — the board's attachMemory
 *                       unless the caller names one), makes it a new node there,
 *                       and adds a row in `ticket.files` { source: 'upload',
 *                       messageId: null } that REFERENCES the node (path =
 *                       memoryRefPath, `memory` set). The file is on the
 *                       ticket (Files tab, counts.files) but in no message yet.
 *   readUploadedFiles   messagePost's `fileIds`: rows that are 'upload' and unattached
 *   attachUploadedFiles …which then flip to source 'message' with messageId set.
 *
 * Browser uploads go into the memory themselves (memoryUploads). Both end up
 * as the same kind of `ticket.files` row — a reference to a memory node.
 */
import { errors, type Attachment, type TicketFile } from '@tm/shared';
import { fileInfo, MAX_API_UPLOAD_BYTES, type FileKind } from '@tm/shared/logic/index';
import type { ServerCtx } from '../runtime/context.js';
import { runTx } from '../runtime/tx.js';
import {
  planMemoryUploads,
  stageMemoryUploads,
  storeBoardFile,
  withUploads,
} from '../memory/attach.js';
import { openTicket, type TicketWriter } from './doc.js';
import {
  loadBoard,
  loadTicket,
  requireActive,
  requireCan,
  requireWritableBoard,
} from './access.js';

export interface UploadInput {
  boardId: string;
  ticketId: string;
  /** The file name as the uploader gave it ('plan.md'); path separators are stripped. */
  name: string;
  /** Optional: guessed from the name when absent or generic (fileInfo). */
  mime?: string | null;
  data: Uint8Array;
  /** The ticket file row's id (the door derives it from an Idempotency-Key). */
  fileId?: string | undefined;
  /** memory.html §J: which memory (default: the board's attachMemory). */
  memoryId?: string | undefined;
  /** …and where in it (default: the board's template; '<ticketId>' is filled). */
  path?: string | undefined;
}

export interface UploadedFile {
  fileId: string;
  /** memoryRefPath(memoryId, nodeId): what the ticket row carries. */
  path: string;
  name: string;
  mime: string;
  size: number;
  kind: FileKind;
  uploadedBy: string;
  createdAt: number;
  memory: { memoryId: string; nodeId: string };
  /** The node's object (memories/{m}/{fileId}/{name}) — for a signed URL. */
  objectPath: string;
}

/** 'reports/Q3 plan.md' → 'Q3 plan.md'; never empty, ≤ 255 chars, no control chars. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const safe = clean === '.' || clean === '..' ? '' : clean;
  return (safe || 'file').slice(0, 255);
}

/**
 * Store an uploaded blob on a ticket for `ctx.actor` (a person or an agent).
 *
 *   can(upload) on the board (commenter+; token scope files:write), board not
 *   archived, ticket active (closed threads take no files), ≤ 25 MB.
 *   blob → memories/{m}/{fileId}/{name}: the board's attachMemory (or
 *     input.memoryId), which must be granted `write` to the board — none → 400
 *   ONE transaction: the new memory node (never replacing one: a taken path
 *     gets ' (2)'…) and ticket.files += { source: 'upload', messageId: null,
 *     path: memoryRefPath, memory }; counts.files follows. If it fails the
 *     blob is removed again.
 */
export async function storeUploadedFile(ctx: ServerCtx, input: UploadInput): Promise<UploadedFile> {
  const { boardId, ticketId } = input;
  const board = await loadBoard(ctx, boardId);
  requireCan(ctx, board, 'upload');
  requireWritableBoard(board);
  const size = input.data.byteLength;
  if (size > MAX_API_UPLOAD_BYTES)
    throw errors.too_large('Files uploaded through the API are limited to 25 MB', {
      size,
      limit: MAX_API_UPLOAD_BYTES,
    });
  const ticket = await loadTicket(boardId, ticketId);
  requireActive(ticket);

  const name = cleanFileName(input.name);
  const info = fileInfo(input.mime ?? null, name);
  const mime = info.mime || 'application/octet-stream';
  const fileId = input.fileId ?? ctx.ids.id();

  const upload = await storeBoardFile(
    ctx,
    board,
    ticket.key,
    { name, mime, bytes: input.data },
    { memoryId: input.memoryId, path: input.path },
  );
  const staged = await stageMemoryUploads([upload]);
  const row = await withUploads(staged, () =>
    runTx(async (tx) => {
      const w = await openTicket(tx, ctx, boardId, ticketId);
      requireActive(w.before);
      const plan = await planMemoryUploads(tx, ctx, staged, boardId, w.before.key);
      const a = plan.attachments[0]!;
      plan.write(tx);
      const row: TicketFile = {
        ...a,
        id: fileId,
        source: 'upload',
        messageId: null,
        createdAt: ctx.now,
        deletedAt: null,
      };
      w.addFiles([row]);
      w.touch();
      w.commit();
      return row;
    }),
  );
  return {
    fileId,
    path: row.path,
    name: row.name,
    mime: row.mime,
    size: row.size,
    kind: fileInfo(row.mime, row.name).kind,
    uploadedBy: ctx.actor,
    createdAt: ctx.now,
    memory: row.memory!,
    objectPath: staged[0]!.file.storagePath,
  };
}

export interface PostedFile {
  fileId: string;
  attachment: Attachment;
}

/**
 * messagePost's fileIds, read off the ticket the writer already holds: each
 * must be a file row of THIS ticket that was uploaded through the API and is
 * not in a message yet (and not deleted). Anything else is a 400 naming the ids.
 */
export function readUploadedFiles(w: TicketWriter, fileIds: readonly string[]): PostedFile[] {
  if (!fileIds.length) return [];
  const rows = fileIds.map((id) => w.file(id));
  const bad = fileIds.filter((_, i) => {
    const r = rows[i];
    return !r || r.source !== 'upload' || r.messageId !== null || r.deletedAt !== null;
  });
  if (bad.length)
    throw errors.invalid('Files must be uploaded to this ticket and not posted yet', {
      field: 'fileIds',
      fileIds: bad,
    });
  return rows.map((r) => {
    const f = r!;
    const attachment: Attachment = {
      id: f.id,
      path: f.path,
      name: f.name,
      mime: f.mime,
      size: f.size,
      ...(f.width && f.height ? { width: f.width, height: f.height } : {}),
      ...(f.thumbPath ? { thumbPath: f.thumbPath } : {}),
      uploadedBy: f.uploadedBy,
      // memory.html §J: an API upload is a reference to a memory node.
      ...(f.memory ? { memory: f.memory } : {}),
    };
    return { fileId: f.id, attachment };
  });
}

/** The rows now belong to the message: source 'message', messageId set. */
export function attachUploadedFiles(
  w: TicketWriter,
  posted: readonly PostedFile[],
  messageId: string,
): void {
  for (const p of posted) w.patchFile(p.fileId, { source: 'message', messageId });
}

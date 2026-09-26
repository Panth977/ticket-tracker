/**
 * Files that arrive through the API (docs/plan/agents.html §F, §G):
 *
 *   storeUploadedFile   POST /v1/tickets/{KEY}/files and MCP upload_file: the
 *                       server writes the blob under the ticket's prefix and a
 *                       a row in `ticket.files` { source: 'upload', messageId: null }.
 *                       The file is on the ticket (Files tab, counts.files) but
 *                       in no message yet.
 *   readUploadedFiles   messagePost's `fileIds`: rows that are 'upload' and unattached
 *   attachUploadedFiles …which then flip to source 'message' with messageId set.
 *
 * Browser uploads keep their own path (direct to Storage, then a command names
 * the path — tickets/attachments.ts). Both end up as the same `ticket.files`
 * row, so the viewer, housekeeping (a row = attached, never swept) and the
 * delete treat them alike.
 */
import { errors, storage, type Attachment, type TicketFile } from '@tm/shared';
import { fileInfo, MAX_API_UPLOAD_BYTES, type FileKind } from '@tm/shared/logic/index';
import { ports } from '../adapters/index.js';
import type { ServerCtx } from '../runtime/context.js';
import { runTx } from '../runtime/tx.js';
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
}

export interface UploadedFile {
  fileId: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  kind: FileKind;
  uploadedBy: string;
  createdAt: number;
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
 *   blob → boards/{b}/tickets/{t}/{fileId}/{encoded name}
 *   ticket.files += { source: 'upload', uploadedBy: actor, messageId: null },
 *   counts.files and signals.fileCount follow — ONE write, after the blob is
 *   written; if it fails the blob is removed again.
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
  requireActive(await loadTicket(boardId, ticketId));

  const name = cleanFileName(input.name);
  const info = fileInfo(input.mime ?? null, name);
  const mime = info.mime || 'application/octet-stream';
  const fileId = ctx.ids.id();
  const path = storage.attachment(boardId, ticketId, fileId, encodeURIComponent(name));

  const files = ports().files;
  await files.write(path, input.data, mime);
  try {
    await runTx(async (tx) => {
      const w = await openTicket(tx, ctx, boardId, ticketId);
      requireActive(w.before);
      const row: TicketFile = {
        id: fileId,
        path,
        name,
        mime,
        size,
        uploadedBy: ctx.actor,
        source: 'upload',
        messageId: null,
        createdAt: ctx.now,
        deletedAt: null,
      };
      w.addFiles([row]);
      w.touch();
      w.commit();
    });
  } catch (e) {
    await files.delete(path).catch(() => {});
    throw e;
  }
  return {
    fileId,
    path,
    name,
    mime,
    size,
    kind: info.kind,
    uploadedBy: ctx.actor,
    createdAt: ctx.now,
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

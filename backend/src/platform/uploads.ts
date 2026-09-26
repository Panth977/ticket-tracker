/**
 * API uploads (POST /v1/tickets/{KEY}/files, MCP upload_file) —
 * docs/plan/agents.html §F/§G.
 *
 * The app uploads straight to Storage and then names the path in a command.
 * A token has no Storage access, so here the DOOR does the upload, into the
 * very same place the app would:
 *
 *   boards/{b}/tickets/{t}/{fileId}/{fileName}           the bytes
 *   boards/{b}/tickets/{t}/files/{fileId}                TicketFile { source: 'upload', messageId: null }
 *
 * The file is then on the ticket (Files tab, counts.files, GET /v1/files/{id})
 * and a later messagePost { fileIds } attaches it to a message (source →
 * 'message'). onAttachmentFinalized adds thumbnails / dimensions for images.
 *
 * IDEMPOTENT: with an Idempotency-Key the file id is derived from it, so a
 * retried upload overwrites the same file instead of adding a second one.
 */
import {
  errors,
  MAX_API_UPLOAD_BYTES,
  type BoardWithId,
  type TicketFile,
  type TicketWithId,
} from '@tm/shared';
import type { ServerCtx } from '../runtime/context.js';
import { requireActive, requireCan } from '../tickets/access.js';
import { storeUploadedFile } from '../tickets/files.js';
import { getFile } from '../tickets/read.js';
import { sha256hex } from './crypto.js';

export interface UploadInput {
  name: string;
  /** Absent / generic: from the extension (fileInfo). */
  mime?: string | undefined;
  bytes: Uint8Array;
}

/** Decode JSON-upload content: exactly one of text (UTF-8) or content_base64. */
export function uploadBytes(u: {
  text?: string | undefined;
  content_base64?: string | undefined;
}): Uint8Array {
  if (u.text !== undefined) return new TextEncoder().encode(u.text);
  const b64 = (u.content_base64 ?? '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64))
    throw errors.invalid('content_base64 is not base64', { field: 'content_base64' });
  return new Uint8Array(
    Buffer.from(b64, b64.includes('-') || b64.includes('_') ? 'base64url' : 'base64'),
  );
}

/** A file id: random, or derived from the Idempotency-Key (same key → same file). */
function fileIdFor(ctx: ServerCtx, ticket: TicketWithId, idemKey?: string): string {
  if (!idemKey) return ctx.ids.id();
  return `up${sha256hex(`${ctx.actor}\n${ticket.id}\n${idemKey}`).slice(0, 22)}`;
}

/**
 * Store one uploaded file on a ticket; answers its files/ row. The work is
 * tickets/files.ts storeUploadedFile (p2-agents-backend) — the one place that
 * writes 'upload' rows; this adds the door's idempotency on top.
 */
export async function storeTicketUpload(
  ctx: ServerCtx,
  board: BoardWithId,
  ticket: TicketWithId,
  input: UploadInput,
  idemKey?: string,
): Promise<TicketFile> {
  requireCan(ctx, board, 'upload', null, null, 'You cannot upload files on this board');
  requireActive(ticket);
  if (input.bytes.length > MAX_API_UPLOAD_BYTES)
    throw errors.too_large(
      `Files are limited to ${MAX_API_UPLOAD_BYTES / 1024 / 1024} MB through the API`,
      {
        size: input.bytes.length,
      },
    );
  const fileId = fileIdFor(ctx, ticket, idemKey);
  if (idemKey) {
    // A retry with the same key is the same file, whatever happened to it since.
    // §W: the file rows are on the ticket itself.
    const prev = await getFile(board.id, ticket.id, fileId);
    if (prev) return prev;
  }
  const up = await storeUploadedFile(
    { ...ctx, ids: { ...ctx.ids, id: () => fileId } },
    {
      boardId: board.id,
      ticketId: ticket.id,
      name: input.name,
      mime: input.mime ?? null,
      data: input.bytes,
    },
  );
  return {
    id: up.fileId,
    path: up.path,
    name: up.name,
    mime: up.mime,
    size: up.size,
    uploadedBy: up.uploadedBy,
    source: 'upload',
    messageId: null,
    createdAt: up.createdAt,
    deletedAt: null,
  };
}

/**
 * UPLOAD DIRECT, ATTACH THROUGH A COMMAND. The browser uploads to Storage
 * under boards/{b}/tickets/{t}/{attachmentId}/{fileName}; ticketCreate and
 * messagePost then name the paths, and this checks each object exists, is
 * under THIS ticket's prefix and is within the size limit before it becomes
 * an Attachment (and a files/ row).
 */
import {
  errors,
  isUnderTicket,
  MAX_ATTACHMENT_BYTES,
  parseAttachmentPath,
  type Attachment,
} from '@tm/shared';
import { ports } from '../adapters/index.js';

export async function resolveAttachments(
  storagePaths: readonly string[] | undefined,
  boardId: string,
  ticketId: string,
  uploadedBy: string,
): Promise<Attachment[]> {
  const list = [...new Set(storagePaths ?? [])];
  const files = ports().files;
  return Promise.all(
    list.map(async (path) => {
      const p = parseAttachmentPath(path);
      if (!p || !isUnderTicket(path, boardId, ticketId))
        throw errors.invalid("Attachments must be uploaded under this ticket's folder", {
          field: 'attachments',
          path,
        });
      const obj = await files.stat(path);
      if (!obj)
        throw errors.invalid('Attachment not found — upload it first', {
          field: 'attachments',
          path,
        });
      if (obj.size > MAX_ATTACHMENT_BYTES)
        throw errors.too_large('Attachment is over 50 MB', { path, size: obj.size });
      let name = p.fileName;
      try {
        name = decodeURIComponent(name);
      } catch {
        /* keep as uploaded */
      }
      // onAttachmentFinalized may have run BEFORE this command (the upload
      // finished first): it left the image facts in the object's metadata.
      const dim = (v: string | undefined) => {
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : undefined;
      };
      const width = dim(obj.metadata?.width);
      const height = dim(obj.metadata?.height);
      const thumbPath = obj.metadata?.thumbPath;
      return {
        id: p.attachmentId,
        path,
        name: name.slice(0, 255) || 'file',
        mime: obj.contentType || 'application/octet-stream',
        size: obj.size,
        ...(width && height ? { width, height } : {}),
        ...(thumbPath && isUnderTicket(thumbPath, boardId, ticketId) ? { thumbPath } : {}),
        uploadedBy,
      } satisfies Attachment;
    }),
  );
}

/**
 * Storage onObjectFinalized (default bucket) — app/backend.json services.onAttachmentFinalized:
 *
 *   boards/{b}/tickets/{t}/{attachmentId}/{fileName}, image/*
 *       → {attachmentId}/thumb_400.webp, and width / height / thumbPath on
 *         the Attachment wherever it is already recorded
 *   users/{uid}/avatar/{file}, image/*
 *       → cropped square 256px webp, written over the original
 *
 * UPLOAD RACES THE COMMAND. The browser uploads, then names the path in
 * messagePost / ticketCreate; this trigger may run before or after that
 * command. So the results go to two places:
 *   - the original object's custom metadata (width, height, thumbPath), for
 *     a command that runs later to copy onto the Attachment;
 *   - files/{…} rows (and their message's attachments[]) that already exist.
 *
 * Every write is idempotent (same inputs → same thumbnail, same fields), so a
 * redelivered event just redoes the work.
 */
import { logger } from 'firebase-functions/v2';
import type { CloudEvent } from 'firebase-functions/v2';
import type { StorageObjectData } from 'firebase-functions/v2/storage';
import {
  parseAttachmentPath,
  storage as storagePaths,
  type Attachment,
  type Message,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import { db, storageAdmin } from '../runtime/firebase.js';
import { defineTrigger } from '../runtime/functions.js';
import { openTicket } from '../tickets/doc.js';
import {
  isThumbnailable,
  makeAvatar,
  makeThumbnail,
  parseAvatarPath,
  PROCESSED_META,
} from '../search/images.js';

export type FinalizedResult =
  | { kind: 'thumbnail'; thumbPath: string; width: number; height: number; patched: number }
  | { kind: 'avatar' }
  | { kind: 'skipped'; reason: string };

export async function handleAttachmentFinalized(
  event: CloudEvent<StorageObjectData>,
): Promise<FinalizedResult> {
  const obj = event.data;
  const name = obj.name;
  if (obj.metadata?.[PROCESSED_META]) return { kind: 'skipped', reason: 'our own output' };
  if (!isThumbnailable(obj.contentType)) return { kind: 'skipped', reason: 'not a raster image' };

  const file = storageAdmin().bucket(obj.bucket).file(name);

  if (parseAvatarPath(name)) {
    const [input] = await file.download();
    const out = await makeAvatar(input);
    await file.save(out.data, {
      resumable: false,
      contentType: 'image/webp',
      metadata: { metadata: { [PROCESSED_META]: 'avatar' } },
    });
    return { kind: 'avatar' };
  }

  const att = parseAttachmentPath(name);
  if (!att) return { kind: 'skipped', reason: 'not an attachment path' };

  const [input] = await file.download();
  let result;
  try {
    result = await makeThumbnail(input);
  } catch (e) {
    // A corrupt / mislabelled upload is the uploader's problem, not a retry loop.
    logger.warn('onAttachmentFinalized: cannot decode image', { name, error: String(e) });
    return { kind: 'skipped', reason: 'undecodable image' };
  }
  const thumbPath = storagePaths.thumb(att.boardId, att.ticketId, att.attachmentId);
  await storageAdmin()
    .bucket(obj.bucket)
    .file(thumbPath)
    .save(result.thumb.data, {
      resumable: false,
      contentType: 'image/webp',
      metadata: { metadata: { [PROCESSED_META]: 'thumb' } },
    });

  const fields = { width: result.original.width, height: result.original.height, thumbPath };
  // For a command that attaches this upload AFTER we ran. (A metadata update
  // fires metageneration events, not finalize, so this does not re-trigger.)
  await file.setMetadata({
    metadata: { width: String(fields.width), height: String(fields.height), thumbPath },
  });
  const patched = await patchRecordedAttachment(att.boardId, att.ticketId, name, fields);
  return { kind: 'thumbnail', ...fields, patched };
}

type ImageFields = Required<Pick<Attachment, 'width' | 'height' | 'thumbPath'>>;

/**
 * Write width/height/thumbPath onto the ticket's file rows for this object and
 * onto the matching entry of their message's attachments[]. Returns rows
 * patched.
 *
 * §W: both live in the ticket document, so this is ONE transaction — and it
 * has to be a transaction, because a reaction or a pin landing meanwhile must
 * not be overwritten.
 */
export async function patchRecordedAttachment(
  boardId: string,
  ticketId: string,
  objectPath: string,
  fields: ImageFields,
): Promise<number> {
  return db().runTransaction(async (tx) => {
    const w = await openTicket(tx, { now: Date.now(), ids: ports().ids }, boardId, ticketId).catch(
      () => null,
    );
    if (!w) return 0;
    const rows = w.files().filter((f) => f.path === objectPath);
    if (!rows.length) return 0;
    const found = await Promise.all(
      rows.map((r) => (r.messageId ? w.locate(r.messageId) : Promise.resolve(null))),
    );
    for (const r of rows) w.patchFile(r.id, fields);
    found.forEach((hit) => {
      if (!hit) return;
      const list = hit.message.attachments as Message['attachments'];
      if (!list.some((a) => a.path === objectPath)) return;
      w.patchMessage(hit, {
        attachments: list.map((a) => (a.path === objectPath ? { ...a, ...fields } : a)),
      });
    });
    w.commit();
    return rows.length;
  });
}

defineTrigger('onAttachmentFinalized', async (event) => {
  await handleAttachmentFinalized(event);
});

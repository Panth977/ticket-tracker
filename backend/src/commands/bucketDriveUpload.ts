/**
 * bucketDriveUpload (bucket.html §K4) — open an upload the browser sends
 * STRAIGHT TO GOOGLE DRIVE, for a Drive bucket: no copy in our object store.
 *
 *   'put'     the bucket's own file (write reach); then bucketFilePut with the
 *             answered storagePath confirms it
 *   'attach'  a ticket file (§J): the bucket must be granted write to
 *             `boardId` and the caller may upload there; the answered
 *             storagePath goes in messagePost / ticketCreate `bucketUploads`
 */
import { BUCKET_UPLOAD_MAX_BYTES, errors } from '@tm/shared';
import { bucketRef, loadBucket } from '../bucket/shared.js';
import { driveOpenUpload, isDriveBucket, openDrive } from '../bucket/drive/store.js';
import { loadBoard, requireCan } from '../tickets/access.js';
import { defineCommand } from './_registry.js';

export default defineCommand('bucketDriveUpload', async (ctx, input) => {
  const { bucketId } = input;
  if (input.size > BUCKET_UPLOAD_MAX_BYTES)
    throw errors.too_large('A bucket file is limited to 1 GB', { size: input.size });
  let bucket;
  if (input.purpose === 'attach') {
    if (!input.boardId) throw errors.invalid('Name the board', { field: 'boardId' });
    const board = await loadBoard(ctx, input.boardId);
    requireCan(ctx, board, 'upload', null, null, 'You cannot add files on this board');
    bucket = (await bucketRef(bucketId).get()).data();
    if (!bucket || bucket.deletingAt || bucket.boards?.[board.id] !== 'write')
      throw errors.invalid(
        "That bucket does not take this board's files — grant it write in board settings › Bucket",
        { field: 'bucketId' },
      );
    if (bucket.archivedAt != null)
      throw errors.conflict('That bucket is archived — restore it first');
    if (bucket.move?.state === 'running')
      throw errors.conflict(
        'That bucket is moving to another storage — try again when the move finishes',
      );
  } else bucket = (await loadBucket(null, bucketId, ctx, 'write')).bucket;
  if (!isDriveBucket(bucket))
    throw errors.invalid('This bucket is not in Google Drive — upload to Storage', {
      field: 'bucketId',
    });
  const d = await openDrive(bucketId, bucket);
  const r = await driveOpenUpload(d, {
    purpose: input.purpose,
    path: input.path,
    nodeId: input.nodeId,
    name: input.name,
    mime: input.mime,
    size: input.size,
    expectedFileId: input.expectedFileId,
    origin: input.origin,
    actor: ctx.actor,
  });
  return { ...r, expiresAt: ctx.now + 7 * 24 * 60 * 60 * 1000 };
});

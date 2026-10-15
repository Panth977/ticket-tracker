/**
 * BOARD ATTACHMENTS ARE RETIRED (docs/plan/bucket.html §J).
 *
 * The browser used to upload under boards/{b}/tickets/{t}/{attachmentId}/{name}
 * and name the path in ticketCreate / messagePost `attachments`. A board takes
 * no files of its own any more: a file goes INTO a bucket granted `write` to
 * the board (`bucketUploads`, bucket/attach.ts) or is an existing bucket file
 * (`bucketRefs`). storage.rules refuses new objects under boards/…, and a
 * non-empty `attachments` is refused here. Rows and objects already on tickets
 * keep working (read, download, delete with their message or ticket).
 */
import { errors } from '@tm/shared';

export const BOARD_ATTACHMENTS_RETIRED =
  'Files go into a bucket now — upload into one of the board’s buckets (bucketUploads), or attach a bucket file (bucketRefs)';

/** A non-empty `attachments` is a 400. */
export function refuseBoardAttachments(paths: readonly string[] | undefined): void {
  if (paths?.length)
    throw errors.invalid(BOARD_ATTACHMENTS_RETIRED, { field: 'attachments', reason: 'retired' });
}

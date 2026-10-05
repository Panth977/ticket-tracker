/**
 * BOARD ATTACHMENTS ARE RETIRED (docs/plan/memory.html §J).
 *
 * The browser used to upload under boards/{b}/tickets/{t}/{attachmentId}/{name}
 * and name the path in ticketCreate / messagePost `attachments`. A board takes
 * no files of its own any more: a file goes INTO a memory granted `write` to
 * the board (`memoryUploads`, memory/attach.ts) or is an existing memory file
 * (`memoryRefs`). storage.rules refuses new objects under boards/…, and a
 * non-empty `attachments` is refused here. Rows and objects already on tickets
 * keep working (read, download, delete with their message or ticket).
 */
import { errors } from '@tm/shared';

export const BOARD_ATTACHMENTS_RETIRED =
  'Files go into a memory now — upload into one of the board’s memories (memoryUploads), or attach a memory file (memoryRefs)';

/** A non-empty `attachments` is a 400. */
export function refuseBoardAttachments(paths: readonly string[] | undefined): void {
  if (paths?.length)
    throw errors.invalid(BOARD_ATTACHMENTS_RETIRED, { field: 'attachments', reason: 'retired' });
}

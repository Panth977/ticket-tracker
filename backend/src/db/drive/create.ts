/**
 * "Google Drive" on a create page (bucket.html §L5): the new entity's folder in
 * its creator's Drive — picked, or a path made for it — and the folders it
 * starts with (a board: tickets/ and files/; an artifact: files/). Made BEFORE
 * the entity, so a Drive that refuses leaves nothing behind.
 */
import type { BoardDriveStorage, BucketStorageInput } from '@tm/shared';
import { isFolder } from '../../bucket/drive/api.js';
import { driveEmail, driveFor } from '../../bucket/drive/link.js';
import { driveBucketFolder } from '../../bucket/drive/store.js';
import type { PrincipalId } from '@tm/shared';

export async function newDriveFolder(
  actor: string,
  input: Extract<BucketStorageInput, { kind: 'drive' }>,
  name: string,
  subfolders: readonly string[],
): Promise<{ storage: BoardDriveStorage; sub: Record<string, string> }> {
  const api = await driveFor(actor);
  const folder = await driveBucketFolder(api, input, name, actor as PrincipalId);
  const kids = await api.children([folder.folderId]);
  const sub: Record<string, string> = {};
  for (const n of subfolders)
    sub[n] =
      kids.find((k) => isFolder(k) && k.name === n)?.id ??
      (await api.createFolder(folder.folderId, n)).id;
  return {
    storage: {
      kind: 'drive',
      uid: actor,
      ...folder,
      email: await driveEmail(actor),
      ...(sub.tickets ? { ticketsFolderId: sub.tickets } : {}),
    },
    sub,
  };
}

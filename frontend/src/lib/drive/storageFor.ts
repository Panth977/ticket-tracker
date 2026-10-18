/**
 * "Where do its files live?" for a NEW board or artifact (bucket.html §K5):
 * one bucket of the chosen storage, made right after the board / artifact,
 * granted `write` to it — and, for a board, its attachment bucket (§J), so
 * ticket files land there from the first upload. Plain commands, in order;
 * the board or artifact already exists if one of them fails (settings › Bucket
 * fixes it by hand).
 */
import { DEFAULT_ATTACH_TEMPLATE, type OwnerRef } from '@tm/shared';
import { command } from '$lib/api';
import { storageInput, type StorageChoice } from './StorageField.svelte';

export async function storageFor(
  choice: StorageChoice,
  target: { boardId: string } | { artifactId: string },
  o: { name: string; owner?: OwnerRef | null },
): Promise<string | null> {
  const storage = storageInput(choice);
  if (!storage) return null;
  const { bucketId } = await command(
    'bucketCreate',
    {
      name: o.name.slice(0, 80),
      description: 'boardId' in target ? 'Ticket files' : 'Files for this artifact',
      storage,
      ...(o.owner ? { owner: o.owner } : {}),
    },
    { toast: false },
  );
  await command('bucketGrantSet', { bucketId, ...target, access: 'write' }, { toast: false });
  if ('boardId' in target)
    await command(
      'boardAttachBucketSet',
      { boardId: target.boardId, attachBucket: { bucketId, template: DEFAULT_ATTACH_TEMPLATE } },
      { toast: false },
    );
  return bucketId;
}

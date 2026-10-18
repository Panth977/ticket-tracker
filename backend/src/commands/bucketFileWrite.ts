/**
 * bucketFileWrite (bucket.html §G) — create or replace a file INLINE: text or
 * base64, ≤ BUCKET_INLINE_MAX_BYTES. The API, MCP, the driver and the app's
 * code mode all save through here. A new version is a new object (D-M2);
 * `expectedFileId` makes the save conditional (409 'stale').
 */
import { errors, BUCKET_INLINE_MAX_BYTES } from '@tm/shared';
import { putVersion, targetName, writeBytes } from '../bucket/files.js';
import { loadBucket } from '../bucket/shared.js';
import { uploadBytes } from '../platform/uploads.js';
import { bytesSource } from '../bucket/drive/api.js';
import { drivePut, isDriveBucket, openDrive } from '../bucket/drive/store.js';
import { defineCommand } from './_registry.js';

export default defineCommand('bucketFileWrite', async (ctx, input) => {
  const { bucketId } = input;
  // Refuse early, before any bytes are stored.
  const { bucket } = await loadBucket(null, bucketId, ctx, 'write');
  let bytes: Uint8Array;
  try {
    bytes = uploadBytes({ text: input.text, content_base64: input.content_base64 });
  } catch (e) {
    throw errors.invalid((e as Error).message, { field: 'content_base64' });
  }
  if (isDriveBucket(bucket)) {
    if (bytes.byteLength > BUCKET_INLINE_MAX_BYTES)
      throw errors.too_large('A file written through the API is limited to 10 MB — upload it in the app', {
        size: bytes.byteLength,
        limit: BUCKET_INLINE_MAX_BYTES,
      });
    const d = await openDrive(bucketId, bucket);
    return drivePut(d, input, bytesSource(bytes), input.mime, ctx.actor, input.expectedFileId);
  }
  const name = await targetName(bucketId, input);
  const file = await writeBytes(ctx, bucketId, name, bytes, input.mime);
  return putVersion(ctx, bucketId, input, file, input.expectedFileId);
});

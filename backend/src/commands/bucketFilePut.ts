/**
 * bucketFilePut (bucket.html §F) — register a file the APP uploaded straight
 * to Storage at buckets/{bucketId}/{fileId}/{name} (storage.rules lets an
 * owner or editor create there, once). Size and content type come from the
 * object itself, never from the request.
 */
import { errors, BUCKET_UPLOAD_MAX_BYTES, parseMemoryStoragePath } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { putVersion } from '../bucket/files.js';
import { loadBucket } from '../bucket/shared.js';
import { drivePut, isDriveBucket, openDrive } from '../bucket/drive/store.js';
import { dropStaged, stagedSource } from '../bucket/drive/staging.js';
import { defineCommand } from './_registry.js';

export default defineCommand('bucketFilePut', async (ctx, input) => {
  const { bucketId, storagePath } = input;
  const { bucket } = await loadBucket(null, bucketId, ctx, 'write');
  const p = parseMemoryStoragePath(storagePath);
  if (!p || p.bucketId !== bucketId)
    throw errors.invalid("Upload under this bucket's folder: buckets/{bucketId}/{fileId}/{name}", {
      field: 'storagePath',
    });
  const obj = await ports().files.stat(storagePath);
  if (!obj) throw errors.invalid('Upload not found — upload it first', { field: 'storagePath' });
  if (obj.size > BUCKET_UPLOAD_MAX_BYTES)
    throw errors.too_large('A bucket file is limited to 1 GB', { size: obj.size });
  if (isDriveBucket(bucket)) {
    // §K4: the upload was a staging copy — into Drive with it, then gone.
    const d = await openDrive(bucketId, bucket);
    try {
      return await drivePut(
        d,
        input,
        stagedSource(storagePath, obj.size),
        obj.contentType,
        ctx.actor,
        input.expectedFileId,
      );
    } finally {
      await dropStaged(storagePath);
    }
  }
  const dim = (v: string | undefined) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const width = dim(obj.metadata?.width);
  const height = dim(obj.metadata?.height);
  return putVersion(
    ctx,
    bucketId,
    input,
    {
      fileId: p.fileId,
      storagePath,
      mime: obj.contentType || 'application/octet-stream',
      size: obj.size,
      ...(width && height ? { width, height } : {}),
    },
    input.expectedFileId,
  );
});

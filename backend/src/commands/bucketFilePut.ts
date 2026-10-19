/**
 * bucketFilePut (bucket.html §F) — register a file the APP uploaded straight
 * to Storage at buckets/{bucketId}/{fileId}/{name} (storage.rules lets an
 * owner or editor create there, once). Size and content type come from the
 * object itself, never from the request.
 *
 * §K4: for a Drive bucket the browser uploaded straight INTO Drive (a session
 * from bucketDriveUpload) and `storagePath` is drive/{bucketId}/{driveId}/…:
 * this only confirms the file is there, in the bucket. Nothing touches our
 * object store.
 */
import {
  errors,
  BUCKET_UPLOAD_MAX_BYTES,
  parseDriveStoragePath,
  parseMemoryStoragePath,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import { putVersion } from '../bucket/files.js';
import { loadBucket } from '../bucket/shared.js';
import { driveById, isDriveBucket, openDrive } from '../bucket/drive/store.js';
import { defineCommand } from './_registry.js';

export default defineCommand('bucketFilePut', async (ctx, input) => {
  const { bucketId, storagePath } = input;
  const { bucket } = await loadBucket(null, bucketId, ctx, 'write');
  if (isDriveBucket(bucket)) {
    const dp = parseDriveStoragePath(storagePath);
    if (!dp || dp.bucketId !== bucketId)
      throw errors.invalid('Upload into Google Drive first (bucketDriveUpload)', {
        field: 'storagePath',
      });
    const found = await driveById(await openDrive(bucketId, bucket), dp.driveId);
    if (!found || found.node.kind !== 'file' || !found.node.file)
      throw errors.invalid('Upload not found in Google Drive — upload it first', {
        field: 'storagePath',
      });
    return { nodeId: found.id, fileId: found.node.file.fileId, path: found.node.path };
  }
  const p = parseMemoryStoragePath(storagePath);
  if (!p || p.bucketId !== bucketId)
    throw errors.invalid("Upload under this bucket's folder: buckets/{bucketId}/{fileId}/{name}", {
      field: 'storagePath',
    });
  const obj = await ports().files.stat(storagePath);
  if (!obj) throw errors.invalid('Upload not found — upload it first', { field: 'storagePath' });
  if (obj.size > BUCKET_UPLOAD_MAX_BYTES)
    throw errors.too_large('A bucket file is limited to 1 GB', { size: obj.size });
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

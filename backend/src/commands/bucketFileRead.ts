/**
 * bucketFileRead (bucket.html §G) — one file: its text (a text file, or
 * asText) up to BUCKET_READ_TEXT_MAX_BYTES, and the file door's short-lived
 * URLs for anything (an image, a video, an APK).
 */
import { errors, isBucketTextFile, BUCKET_READ_TEXT_MAX_BYTES } from '@tm/shared';
import { readStream } from '../adapters/files.js';
import { readTarget } from '../bucket/nodes.js';
import { loadBucket, toNodeOut } from '../bucket/shared.js';
import { driveTarget, isDriveBucket, openDrive } from '../bucket/drive/store.js';
import { signedAccess } from '../platform/fileAccess.js';
import { defineCommand } from './_registry.js';

async function readPrefix(
  path: string,
  size: number,
): Promise<{ text: string; truncated: boolean }> {
  const max = BUCKET_READ_TEXT_MAX_BYTES;
  if (size === 0) return { text: '', truncated: false };
  const end = Math.min(size, max) - 1;
  const chunks: Buffer[] = [];
  for await (const c of readStream(path, { start: 0, end })) chunks.push(c as Buffer);
  let buf = Buffer.concat(chunks);
  // Never cut a UTF-8 sequence in half at the limit.
  if (size > max)
    while (buf.length && (buf[buf.length - 1]! & 0xc0) === 0x80) buf = buf.subarray(0, -1);
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf), truncated: size > max };
}

export default defineCommand('bucketFileRead', async (ctx, input) => {
  const { bucketId } = input;
  const { bucket } = await loadBucket(null, bucketId, ctx, 'read');
  const found = isDriveBucket(bucket)
    ? await driveTarget(await openDrive(bucketId, bucket), input)
    : await readTarget(null, bucketId, input);
  const file = found.node.file;
  if (found.node.kind !== 'file' || !file)
    throw errors.invalid(`${found.node.path} is a folder — list it with bucketTree`, {
      field: 'path',
    });
  const access = await signedAccess(ctx, file.storagePath);
  const wantText = input.asText ?? isBucketTextFile(found.node.name, file.mime);
  const read = wantText ? await readPrefix(file.storagePath, file.size) : null;
  return {
    node: toNodeOut(found.id, found.node),
    text: read?.text ?? null,
    truncated: read?.truncated ?? false,
    ...access,
  };
});

/**
 * THE APP UPLOADS EVERY FILE THE SAME WAY (bucket.html §K4): straight to our
 * object store under buckets/{bucketId}/{fileId}/{name}, whatever the bucket's
 * storage. For a Drive bucket that object is only a STAGING copy: the command
 * that registers it (bucketFilePut, a ticket's bucketUploads) streams it into
 * Drive in chunks and deletes it. One upload path in the browser, no Google
 * token in the browser, and the bytes never sit whole in memory.
 */
import { ports } from '../../adapters/index.js';
import { readStream } from '../../adapters/files.js';
import type { ByteSource } from './api.js';

/** Chunks of a staged object, read by range (`end` exclusive). */
export function stagedSource(storagePath: string, size: number): ByteSource {
  return {
    size,
    async read(start, end) {
      if (end <= start) return new Uint8Array();
      const chunks: Buffer[] = [];
      for await (const c of readStream(storagePath, { start, end: end - 1 }))
        chunks.push(Buffer.from(c as Uint8Array));
      return new Uint8Array(Buffer.concat(chunks));
    },
  };
}

/** The staging copy is not needed once Drive has the file. */
export async function dropStaged(storagePath: string): Promise<void> {
  await ports()
    .files.delete(storagePath)
    .catch((e) => console.warn('[drive] could not delete a staged upload', storagePath, e));
}

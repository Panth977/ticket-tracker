/**
 * StorageFiles over the Admin SDK default bucket. Works against the Storage
 * emulator (FIREBASE_STORAGE_EMULATOR_HOST); signed URLs cannot be signed
 * there (no service account), so under the emulator they are the emulator's
 * plain REST URLs instead.
 */
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { StorageFiles, StoredObject } from '@tm/shared';
import { storageAdmin } from '../runtime/firebase.js';

/**
 * A read stream over a stored object, optionally one byte range (`end` is
 * INCLUSIVE, as in an HTTP Range header).
 *
 * Deliberately NOT part of the StorageFiles port: only the file-access door
 * (platform/fileAccess.ts) needs it, and it needs it to answer a Range request
 * without pulling a 50 MB video into memory first. Everything else reads whole
 * objects through `read`.
 */
export function readStream(path: string, range?: { start: number; end: number }): Readable {
  return storageAdmin()
    .bucket()
    .file(path)
    .createReadStream(range ? { start: range.start, end: range.end } : {});
}

export function adminFiles(): StorageFiles {
  const bucket = () => storageAdmin().bucket();
  const emu = () => process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const meta = (
    path: string,
    m: { size?: string | number; contentType?: string; metadata?: Record<string, unknown> },
  ): StoredObject => ({
    path,
    size: Number(m.size ?? 0),
    contentType: m.contentType ?? 'application/octet-stream',
    ...(m.metadata
      ? {
          metadata: Object.fromEntries(
            Object.entries(m.metadata)
              .filter(([, v]) => v != null)
              .map(([k, v]) => [k, String(v)]),
          ),
        }
      : {}),
  });

  return {
    async stat(path) {
      const f = bucket().file(path);
      const [exists] = await f.exists();
      if (!exists) return null;
      const [m] = await f.getMetadata();
      return meta(path, m);
    },
    async read(path) {
      const [buf] = await bucket().file(path).download();
      return new Uint8Array(buf);
    },
    async write(path, data, contentType) {
      // A DOWNLOAD TOKEN, KEPT AS A FALLBACK. The browser SDK's
      // getDownloadURL() needs `firebaseStorageDownloadTokens` in the object's
      // custom metadata; uploads made from a browser get one automatically,
      // uploads made here (the API / MCP) do not — so an agent's .md or .html
      // showed "Could not load this file" while the same file attached from the
      // app opened fine. Since phase 11 the app reads every file through
      // /api/files/* instead, so nothing depends on this any more — but a
      // token costs nothing and keeps getDownloadURL() working for anything
      // that still holds a path (and for poking at an object by hand).
      await bucket()
        .file(path)
        .save(Buffer.from(data), {
          contentType,
          resumable: false,
          metadata: { metadata: { firebaseStorageDownloadTokens: randomUUID() } },
        });
    },
    async copy(from, to) {
      await bucket().file(from).copy(bucket().file(to));
    },
    async delete(path) {
      await bucket().file(path).delete({ ignoreNotFound: true });
    },
    async deletePrefix(prefix) {
      await bucket().deleteFiles({ prefix, force: true });
    },
    async list(prefix) {
      const [files] = await bucket().getFiles({ prefix });
      return files.map((f) => meta(f.name, f.metadata));
    },
    async signedUploadUrl(path, contentType, expiresAt) {
      const host = emu();
      if (host) {
        return `http://${host}/upload/storage/v1/b/${bucket().name}/o?uploadType=media&name=${encodeURIComponent(path)}`;
      }
      const [url] = await bucket()
        .file(path)
        .getSignedUrl({ version: 'v4', action: 'write', expires: expiresAt, contentType });
      return url;
    },
    async signedDownloadUrl(path, expiresAt) {
      const host = emu();
      if (host)
        return `http://${host}/v0/b/${bucket().name}/o/${encodeURIComponent(path)}?alt=media`;
      const [url] = await bucket()
        .file(path)
        .getSignedUrl({ version: 'v4', action: 'read', expires: expiresAt });
      return url;
    },
  };
}

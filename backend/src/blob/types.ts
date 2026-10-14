/**
 * THE FILE-STORAGE PORT — the one object-store API every module talks to.
 *
 * Cloud-Storage-SHAPED, for the same reason the database port is
 * Firestore-shaped: it is what the code was written against, and it maps
 * onto any store of "bytes at a path, with a little metadata" — Cloud
 * Storage, a directory on disk, S3 … A new store is a new adapter in
 * src/blob/; no caller changes.
 *
 * Rules for code above the port: get a bucket with storageBucket() from
 * 'src/blob/index.js', never from storageAdmin(); use only what is
 * declared here (add it here AND to every adapter AND to test/blob/suite.ts
 * first).
 */
import type { Readable } from 'node:stream';

/** What the code reads off an object. Times are ISO strings, sizes may be strings (as GCS answers). */
export interface ObjectMetadata {
  name?: string;
  size?: string | number;
  contentType?: string;
  timeCreated?: string;
  updated?: string;
  /** Custom metadata (string values). */
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

export interface SaveOptions {
  contentType?: string;
  resumable?: boolean;
  metadata?: { metadata?: Record<string, string> } & Record<string, unknown>;
}

export interface SignedUrlConfig {
  version?: 'v2' | 'v4';
  action: 'read' | 'write';
  /** Epoch ms, a Date or an ISO string. */
  expires: number | Date | string;
  contentType?: string;
}

export interface BlobFile {
  readonly name: string;
  /** Metadata as last fetched (set on files returned by getFiles()). */
  readonly metadata: ObjectMetadata;
  exists(): Promise<[boolean]>;
  getMetadata(): Promise<[ObjectMetadata, ...unknown[]]>;
  /** Merge custom metadata (`{ metadata: { k: v } }`). */
  setMetadata(
    metadata: { metadata?: Record<string, string | null> } & Record<string, unknown>,
  ): Promise<unknown>;
  download(): Promise<[Buffer]>;
  save(data: Buffer | Uint8Array | string, options?: SaveOptions): Promise<void>;
  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
  copy(destination: BlobFile): Promise<unknown>;
  /** `end` is INCLUSIVE, as in an HTTP Range header. */
  createReadStream(options?: { start?: number; end?: number }): Readable;
  getSignedUrl(config: SignedUrlConfig): Promise<[string]>;
}

export interface GetFilesOptions {
  prefix?: string;
  maxResults?: number;
  autoPaginate?: boolean;
}

export interface Bucket {
  readonly name: string;
  file(name: string): BlobFile;
  getFiles(options?: GetFilesOptions): Promise<[BlobFile[], ...unknown[]]>;
  deleteFiles(options?: { prefix?: string; force?: boolean }): Promise<void>;
}

/** An object written to the store (the "finalize" event the attachment trigger hangs off). */
export interface FinalizedObject {
  bucket: string;
  name: string;
  contentType?: string;
  size?: string;
  metadata?: Record<string, string>;
}

export interface BlobAdapter {
  readonly name: string;
  /** The default bucket, or a named one. */
  bucket(name?: string): Bucket;
}

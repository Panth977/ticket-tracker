/**
 * drive/{bucketId}/{driveId}/{name} as an OBJECT (bucket.html §K3): what the
 * file door, signedAccess and bucketFileRead ask the object store, answered
 * from Drive. adapters/files.ts routes these paths here, so nothing above the
 * port tells a Drive file from one of ours.
 *
 * No reach is checked here — the callers did (requireFileRead, a bucket
 * command), exactly as for an object in our own store.
 */
import { Readable } from 'node:stream';
import { parseDriveStoragePath, type StoredObject } from '@tm/shared';
import { bucketRef } from '../shared.js';
import { isFolder } from './api.js';
import { isDriveBucket, openDrive, type DriveBucket } from './store.js';

async function open(path: string): Promise<{ d: DriveBucket; driveId: string } | null> {
  const p = parseDriveStoragePath(path);
  if (!p) return null;
  const bucket = (await bucketRef(p.bucketId).get()).data();
  if (!bucket || bucket.deletingAt || !isDriveBucket(bucket)) return null;
  return { d: await openDrive(p.bucketId, bucket), driveId: p.driveId };
}

export async function driveObjectStat(path: string): Promise<StoredObject | null> {
  const o = await open(path);
  if (!o) return null;
  const f = await o.d.api.get(o.driveId);
  if (!f || f.trashed || isFolder(f)) return null;
  return { path, size: f.size, contentType: f.mimeType || 'application/octet-stream' };
}

export async function driveObjectRead(path: string): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const c of driveObjectStream(path)) chunks.push(Buffer.from(c as Uint8Array));
  return new Uint8Array(Buffer.concat(chunks));
}

/** A stream right away (the port's readStream is synchronous); Drive is asked on first read. */
export function driveObjectStream(path: string, range?: { start: number; end: number }): Readable {
  return Readable.from(
    (async function* () {
      const o = await open(path);
      if (!o) throw new Error('File not found');
      yield* await o.d.api.download(o.driveId, range);
    })(),
  );
}

/** A version's object is deleted when it is replaced — in Drive the revision IS the file: nothing to do. */
export async function driveObjectDelete(_path: string): Promise<void> {}

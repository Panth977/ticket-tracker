/**
 * File storage, behind one port (types.ts). TM_BLOB (else TM_PLATFORM)
 * picks the adapter once, at startup:
 *
 *   'gcs'  (firebase)  Cloud Storage through the Admin SDK (emulator-aware)
 *   'disk' (vm)        files under TM_BLOB_DIR — see disk.ts
 *
 * Everything above this file gets buckets from storageBucket(); nothing above it
 * knows which store is underneath.
 */
import { adapterFor } from '../runtime/platform.js';
import { diskAdapter } from './disk.js';
import { gcsAdapter } from './gcs.js';
import type { BlobAdapter, Bucket } from './types.js';

export type * from './types.js';

export type BlobKind = 'gcs' | 'disk';

/** The object store this process uses: TM_BLOB, else the platform's. */
export function blobKind(): BlobKind {
  return adapterFor<BlobKind>('TM_BLOB', { firebase: 'gcs', vm: 'disk' }, ['gcs', 'disk']);
}

const adapter: BlobAdapter = blobKind() === 'disk' ? diskAdapter : gcsAdapter;

/** The default bucket, or a named one. */
export function storageBucket(name?: string): Bucket {
  return adapter.bucket(name);
}

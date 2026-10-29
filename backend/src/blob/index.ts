/**
 * File storage, behind one port (types.ts): IceBase's storage — Cloud Storage on Firebase, the
 * IceBase server's on it (TM_ICEBASE), through the Admin SDK's bucket API either way.
 *
 * Everything above this file gets buckets from storageBucket().
 */
import { gcsAdapter } from './gcs.js';
import type { Bucket } from './types.js';

export type * from './types.js';

/** The default bucket, or a named one. */
export function storageBucket(name?: string): Bucket {
  return gcsAdapter.bucket(name);
}

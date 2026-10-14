/**
 * The Cloud Storage adapter: the Admin SDK's bucket itself. The port
 * (types.ts) is a subset of its API, so there is no wrapper.
 */
import { storageAdmin } from '../runtime/firebase.js';
import type { BlobAdapter, Bucket } from './types.js';

export const gcsAdapter: BlobAdapter = {
  name: 'gcs',
  bucket: (name?: string) => storageAdmin().bucket(name) as unknown as Bucket,
};

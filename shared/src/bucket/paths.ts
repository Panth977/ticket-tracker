/**
 * BUCKET (docs/plan/bucket.html) — where the bytes are, and the virtual path
 * a ticket's reference carries (§E).
 */

/** Storage: buckets/{bucketId}/{fileId}/{fileName} — one object per VERSION (D-M2). */
export const bucketStoragePath = (bucketId: string, fileId: string, fileName: string): string =>
  `buckets/${bucketId}/${fileId}/${fileName}`;

/** Everything a bucket owns in Storage (the delete job's prefix). Ends with '/'. */
export const bucketStoragePrefix = (bucketId: string): string => `buckets/${bucketId}/`;

const STORAGE_OBJECT = /^buckets\/([A-Za-z0-9_-]{6,64})\/([A-Za-z0-9_-]{6,64})\/([^/]+)$/;

/** buckets/{m}/{fileId}/{name} → its parts, or null. */
export function parseMemoryStoragePath(
  path: string,
): { bucketId: string; fileId: string; fileName: string } | null {
  const m = STORAGE_OBJECT.exec(path);
  return m ? { bucketId: m[1]!, fileId: m[2]!, fileName: m[3]! } : null;
}

/**
 * §E: the path a ticket's bucket reference carries in `ticket.files[].path`.
 * There is NO object there: the file door resolves it to the node's CURRENT
 * version, so every ticket pointing at a node sees its latest bytes.
 */
export const bucketRefPath = (bucketId: string, nodeId: string): string =>
  `buckets/${bucketId}/nodes/${nodeId}`;

const REF = /^buckets\/([A-Za-z0-9_-]{6,64})\/nodes\/([A-Za-z0-9_-]{6,64})$/;

export function parseBucketRefPath(path: string): { bucketId: string; nodeId: string } | null {
  const m = REF.exec(path);
  return m ? { bucketId: m[1]!, nodeId: m[2]! } : null;
}

/** The app's routes for a bucket (frontend lib/layout/routes mirrors these). */
export const bucketAppPath = (bucketId: string, path?: string | null): string =>
  `/bucket/${bucketId}${path ? `?path=${encodeURIComponent(path)}` : ''}`;

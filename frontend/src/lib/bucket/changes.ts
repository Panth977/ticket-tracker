/**
 * "This bucket just changed" — for the stores that cannot listen to Firestore:
 * a Drive bucket's tree (bucket.html §K2) is read with bucketTree, so after
 * every bucket write the app makes, its store reads again. The command client
 * ($lib/api) calls bucketChanged; driveNodes subscribes.
 */
type Fn = (bucketId: string) => void;
const subs = new Set<Fn>();

/** Commands after which a bucket's tree is no longer what was read. */
export const BUCKET_WRITES: ReadonlySet<string> = new Set([
  'bucketFileWrite',
  'bucketFilePut',
  'bucketFolderCreate',
  'bucketMove',
  'bucketNodeDelete',
]);

export function bucketChanged(bucketId: string | undefined): void {
  if (bucketId) for (const f of subs) f(bucketId);
}

export function onBucketChanged(fn: Fn): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

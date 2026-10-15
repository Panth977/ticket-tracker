/**
 * What every bucket-settings section reads: the live bucket and who I am on
 * it. Provided by routes/bucket/[bucketId]/settings/+layout.svelte (as artifact
 * settings do).
 */
import { getContext, setContext } from 'svelte';
import type { Bucket, BucketRole } from '@tm/shared';
import type { WithId } from '$lib/stores';

export interface BucketSettings {
  readonly bucket: WithId<Bucket>;
  readonly me: string;
  readonly role: BucketRole;
  readonly isOwner: boolean;
}

const KEY = Symbol('bucket-settings');
export const provideBucketSettings = (s: BucketSettings): void => {
  setContext(KEY, s);
};
export const useBucketSettings = (): BucketSettings => getContext<BucketSettings>(KEY);

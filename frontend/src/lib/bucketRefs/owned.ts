/**
 * The buckets I OWN (bucket.html §D): the only ones I may grant to a board or
 * an artifact. A small query of its own, so the settings sections do not
 * depend on the Bucket app's store. Live: a grant set elsewhere shows here.
 */
import type { Readable } from 'svelte/store';
import { derived } from 'svelte/store';
import { paths, type Bucket, type BucketGrant } from '@tm/shared';
import { queryStore, type QueryState } from '$lib/stores';

export function ownedBuckets(uid: string | null | undefined): Readable<QueryState<Bucket>> {
  const q = queryStore<Bucket>(
    uid ? { path: paths.buckets(), where: [['memberUids', 'array-contains', uid]] } : null,
  );
  return derived(q, (s) => ({
    ...s,
    data: s.data
      .filter((m) => uid && m.access?.[uid] === 'owner' && !m.deletingAt)
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/** A grant target: one board or one artifact. */
export type GrantTarget = { boardId: string } | { artifactId: string };

/** What `m` grants this target, or null. */
export function grantOf(
  m: Pick<Bucket, 'boards' | 'artifacts'>,
  target: GrantTarget,
): BucketGrant | null {
  return 'boardId' in target
    ? (m.boards?.[target.boardId] ?? null)
    : (m.artifacts?.[target.artifactId] ?? null);
}

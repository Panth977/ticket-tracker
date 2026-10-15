/**
 * The buckets granted to one board, each with WHAT it grants the board when
 * that can be known (bucket.html §J needs `write`). bucketList({ boardId })
 * answers the buckets but only the caller's own reach; the grant itself is on
 * the bucket document, which its own people (owner / editors / viewers) may
 * read. Everyone else falls back to isWriteGranted's reading of reach.
 */
import { collection, getDocs, query, where } from 'firebase/firestore';
import { paths, type Bucket } from '@tm/shared';
import { command } from '$lib/api';
import { getDb } from '$lib/firebase/client';
import type { BoardBucketOut } from './attach';

export async function loadBoardBuckets(
  boardId: string,
  uid: string | null | undefined,
): Promise<BoardBucketOut[]> {
  const [listed, mine] = await Promise.all([
    command('bucketList', { boardId }, { toast: false }),
    uid
      ? getDocs(
          query(collection(getDb(), paths.buckets()), where('memberUids', 'array-contains', uid)),
        ).catch(() => null)
      : Promise.resolve(null),
  ]);
  const grants = new Map(
    (mine?.docs ?? []).map((d) => [d.id, (d.data() as Bucket).boards?.[boardId] ?? null] as const),
  );
  return listed.buckets.map((m): BoardBucketOut => {
    const known = m as BoardBucketOut;
    if (known.boardGrant !== undefined || !grants.has(m.id)) return known;
    return { ...m, boardGrant: grants.get(m.id) ?? null };
  });
}

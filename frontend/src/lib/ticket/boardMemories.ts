/**
 * The memories granted to one board, each with WHAT it grants the board when
 * that can be known (memory.html §J needs `write`). memoryList({ boardId })
 * answers the memories but only the caller's own reach; the grant itself is on
 * the memory document, which its own people (owner / editors / viewers) may
 * read. Everyone else falls back to isWriteGranted's reading of reach.
 */
import { collection, getDocs, query, where } from 'firebase/firestore';
import { paths, type Memory } from '@tm/shared';
import { command } from '$lib/api';
import { getDb } from '$lib/firebase/client';
import type { BoardMemoryOut } from './attach';

export async function loadBoardMemories(
  boardId: string,
  uid: string | null | undefined,
): Promise<BoardMemoryOut[]> {
  const [listed, mine] = await Promise.all([
    command('memoryList', { boardId }, { toast: false }),
    uid
      ? getDocs(
          query(collection(getDb(), paths.memories()), where('memberUids', 'array-contains', uid)),
        ).catch(() => null)
      : Promise.resolve(null),
  ]);
  const grants = new Map(
    (mine?.docs ?? []).map((d) => [d.id, (d.data() as Memory).boards?.[boardId] ?? null] as const),
  );
  return listed.memories.map((m): BoardMemoryOut => {
    const known = m as BoardMemoryOut;
    if (known.boardGrant !== undefined || !grants.has(m.id)) return known;
    return { ...m, boardGrant: grants.get(m.id) ?? null };
  });
}

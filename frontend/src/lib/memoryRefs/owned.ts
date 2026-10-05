/**
 * The memories I OWN (memory.html §D): the only ones I may grant to a board or
 * an artifact. A small query of its own, so the settings sections do not
 * depend on the Memory app's store. Live: a grant set elsewhere shows here.
 */
import type { Readable } from 'svelte/store';
import { derived } from 'svelte/store';
import { paths, type Memory, type MemoryGrant } from '@tm/shared';
import { queryStore, type QueryState } from '$lib/stores';

export function ownedMemories(uid: string | null | undefined): Readable<QueryState<Memory>> {
  const q = queryStore<Memory>(
    uid ? { path: paths.memories(), where: [['memberUids', 'array-contains', uid]] } : null,
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
  m: Pick<Memory, 'boards' | 'artifacts'>,
  target: GrantTarget,
): MemoryGrant | null {
  return 'boardId' in target
    ? (m.boards?.[target.boardId] ?? null)
    : (m.artifacts?.[target.artifactId] ?? null);
}

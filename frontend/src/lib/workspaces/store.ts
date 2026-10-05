/**
 * WORKSPACES (agents.html §AB) — the person's own bundles of boards,
 * artifacts and memories (memory.html §F), and what they hid from the sidebar's root. Read straight from
 * users/{uid}/…; written only through the commands (workspaceCreate /
 * workspaceUpdate / workspaceDelete / sidebarHide).
 */
import { derived, type Readable } from 'svelte/store';
import { paths, type SidebarPrefs, type Workspace } from '@tm/shared';
import { outbox } from '$lib/api';
import { docStore, queryStore, type QueryState, type WithId } from '$lib/stores';

export function myWorkspaces(uid: string | null | undefined): Readable<QueryState<Workspace>> {
  return queryStore<Workspace>(
    uid ? { path: paths.workspaces(uid), orderBy: [['position', 'asc']] } : null,
  );
}

export interface Hidden {
  boards: ReadonlySet<string>;
  artifacts: ReadonlySet<string>;
  memories: ReadonlySet<string>;
}

/** What is hidden from the sidebar's root lists (empty sets until the doc exists). */
export function hiddenItems(uid: string | null | undefined): Readable<Hidden> {
  return derived(docStore<SidebarPrefs>(uid ? paths.sidebarPrefs(uid) : null), (s) => ({
    boards: new Set(s.data?.hiddenBoardIds ?? []),
    artifacts: new Set(s.data?.hiddenArtifactIds ?? []),
    memories: new Set(s.data?.hiddenMemoryIds ?? []),
  }));
}

/**
 * Hide / show again — at once on screen (the overlay patches the list), the
 * command behind it. `current` is what is hidden now, so the patch is whole.
 */
export function setHidden(
  uid: string,
  current: Hidden,
  item: { boardId: string } | { artifactId: string } | { memoryId: string },
  hidden: boolean,
  label: string,
): void {
  const flip = (set: ReadonlySet<string>, id: string) =>
    hidden ? [...new Set([...set, id])] : [...set].filter((x) => x !== id);
  const patch =
    'boardId' in item
      ? { hiddenBoardIds: flip(current.boards, item.boardId) }
      : 'artifactId' in item
        ? { hiddenArtifactIds: flip(current.artifacts, item.artifactId) }
        : { hiddenMemoryIds: flip(current.memories, item.memoryId) };
  outbox.queue(
    'sidebarHide',
    { ...item, hidden },
    {
      label: `${hidden ? 'Hide' : 'Show'} ${label}`,
      optimistic: { path: paths.sidebarPrefs(uid), patch },
    },
  );
}

/** The workspaces an id belongs to, by name — for "In: Freelance, Clients" hints. */
export function workspacesOf(
  list: readonly WithId<Workspace>[],
  item: { boardId: string } | { artifactId: string } | { memoryId: string },
): WithId<Workspace>[] {
  return list.filter((w) =>
    'boardId' in item
      ? w.boardIds.includes(item.boardId)
      : 'artifactId' in item
        ? w.artifactIds.includes(item.artifactId)
        : (w.memoryIds ?? []).includes(item.memoryId),
  );
}

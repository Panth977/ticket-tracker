/**
 * What a person hid from the sidebar's root lists (users/{uid}/ui/sidebar),
 * read live; written only through sidebarHide. Hiding is about the sidebar
 * only: the All pages and an owner's page still show the item.
 */
import { derived, type Readable } from 'svelte/store';
import { paths, type SidebarPrefs } from '@tm/shared';
import { outbox } from '$lib/api';
import { docStore } from '$lib/stores';

export interface Hidden {
  boards: ReadonlySet<string>;
  artifacts: ReadonlySet<string>;
  buckets: ReadonlySet<string>;
}

/** What is hidden from the sidebar's root lists (empty sets until the doc exists). */
export function hiddenItems(uid: string | null | undefined): Readable<Hidden> {
  return derived(docStore<SidebarPrefs>(uid ? paths.sidebarPrefs(uid) : null), (s) => ({
    boards: new Set(s.data?.hiddenBoardIds ?? []),
    artifacts: new Set(s.data?.hiddenArtifactIds ?? []),
    buckets: new Set(s.data?.hiddenBucketIds ?? []),
  }));
}

/**
 * Hide / show again — at once on screen (the overlay patches the list), the
 * command behind it. `current` is what is hidden now, so the patch is whole.
 */
export function setHidden(
  uid: string,
  current: Hidden,
  item: { boardId: string } | { artifactId: string } | { bucketId: string },
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
        : { hiddenBucketIds: flip(current.buckets, item.bucketId) };
  outbox.queue(
    'sidebarHide',
    { ...item, hidden },
    {
      label: `${hidden ? 'Hide' : 'Show'} ${label}`,
      optimistic: { path: paths.sidebarPrefs(uid), patch },
    },
  );
}

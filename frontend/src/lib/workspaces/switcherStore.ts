/**
 * The title dropdown's data, wired once (./switcher): my boards, artifacts,
 * buckets and workspaces → { workspace, items } for whatever is open. The
 * board bar, the artifact header (and its settings) and the bucket header all
 * read it, so they show the same list in the same order.
 */
import { derived, type Readable } from 'svelte/store';
import { splitArtifacts, myArtifacts } from '$lib/artifacts/store';
import { myBuckets, splitBuckets } from '$lib/bucket/store';
import { myBoards, type WithId } from '$lib/stores';
import type { MenuItem } from '$lib/ui/types';
import type { Workspace } from '@tm/shared';
import { workspaceContext } from './context.svelte';
import { myWorkspaces } from './store';
import { activeWorkspace, switcherItems, type Current } from './switcher';

export interface SwitcherState {
  workspace: WithId<Workspace> | null;
  items: MenuItem[];
}

/**
 * `contextId` is workspaceContext.id, passed in so a Svelte caller's $derived
 * re-runs when it changes (it is rune state, not a store).
 */
export function switcherFor(
  uid: string | null | undefined,
  current: Current,
  contextId: string | null,
): Readable<SwitcherState> {
  return derived(
    [myBoards(uid), myArtifacts(uid), myBuckets(uid), myWorkspaces(uid)],
    ([b, a, m, w]) => {
      const workspace = activeWorkspace(w.data, contextId, current);
      return {
        workspace,
        items: switcherItems({
          boards: b.data,
          artifacts: splitArtifacts(a.data).active,
          buckets: splitBuckets(m.data).active,
          workspace,
          current,
          leave: () => workspaceContext.leave(),
        }),
      };
    },
  );
}

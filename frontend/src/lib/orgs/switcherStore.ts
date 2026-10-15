/**
 * The title dropdown's data, wired once (./switcher): my boards, artifacts,
 * buckets and orgs → { org, items } for whatever is open. The board bar, the
 * artifact header (and its settings) and the bucket header all read it.
 */
import { derived, type Readable } from 'svelte/store';
import type { Org } from '@tm/shared';
import { splitArtifacts, myArtifacts } from '$lib/artifacts/store';
import { myBuckets, splitBuckets } from '$lib/bucket/store';
import { myBoards, type WithId } from '$lib/stores';
import type { MenuItem } from '$lib/ui/types';
import { myOrgs } from './store';
import { ownerOrg, switcherItems, type Current } from './switcher';

export interface SwitcherState {
  org: WithId<Org> | null;
  items: MenuItem[];
}

export function switcherFor(
  uid: string | null | undefined,
  current: Current,
): Readable<SwitcherState> {
  return derived([myBoards(uid), myArtifacts(uid), myBuckets(uid), myOrgs(uid)], ([b, a, m, o]) => {
    const things = {
      boards: b.data,
      artifacts: splitArtifacts(a.data).active,
      buckets: splitBuckets(m.data).active,
    };
    const org = ownerOrg(o.data, things, current);
    return { org, items: switcherItems({ ...things, org, current }) };
  });
}

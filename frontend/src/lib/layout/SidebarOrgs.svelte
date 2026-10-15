<!--
  ORGS in the sidebar (agents.html §AC). One row per org I am in — ▸ mark
  Name — which opens its page (/{handle}); ▸ unfolds what it owns right here:
  its boards, artifacts and buckets (the ones I can open). What an org owns
  lives here, not in the root lists. Boards, artifacts and buckets come in
  from the Sidebar (no second listener).
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path, so resolve() would be the identity.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { ChevronRight, Plus } from 'lucide-svelte';
  import type { Artifact, Board, BoardPref, Bucket } from '@tm/shared';
  import Indicator from '$lib/ui/Indicator.svelte';
  import { BUCKET_DEFAULT_INDICATOR } from '@tm/shared';
  import { auth } from '$lib/firebase/auth.svelte';
  import type { WithId } from '$lib/stores';
  import { myOrgs } from '$lib/orgs/store';
  import NewOrgDialog from '$lib/orgs/NewOrgDialog.svelte';
  import SidebarBoard from './SidebarBoard.svelte';
  import { routes } from './routes';

  interface Props {
    boards: readonly WithId<Board>[];
    artifacts: readonly WithId<Artifact>[];
    buckets: readonly WithId<Bucket>[];
    prefs: ReadonlyMap<string, BoardPref | null>;
    unread: ReadonlyMap<string, number>;
    path: string;
    currentKey: string | null;
    currentArtifact: string | null;
    currentBucket: string | null;
  }
  let {
    boards,
    artifacts,
    buckets,
    prefs,
    unread,
    path,
    currentKey,
    currentArtifact,
    currentBucket,
  }: Props = $props();

  const orgsQ = $derived(myOrgs(auth.uid));
  const orgs = $derived([...$orgsQ.data].sort((a, b) => a.name.localeCompare(b.name)));
  const of = <T extends { ownerKey?: string | null }>(list: readonly T[], orgId: string) =>
    list.filter((t) => t.ownerKey === `org:${orgId}`);

  // Which are unfolded: remembered per browser; the one holding the open item is always open.
  const OPEN_KEY = 'tm.orgs.open';
  let unfolded = $state<string[]>(load());
  function load(): string[] {
    try {
      return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]') as string[];
    } catch {
      return [];
    }
  }
  function fold(id: string) {
    unfolded = unfolded.includes(id) ? unfolded.filter((x) => x !== id) : [...unfolded, id];
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(unfolded));
    } catch {
      /* private mode */
    }
  }
  const holdsCurrent = (orgId: string) =>
    of(boards, orgId).some((b) => b.key === currentKey) ||
    of(artifacts, orgId).some((a) => a.id === currentArtifact || a.slug === currentArtifact) ||
    of(buckets, orgId).some((m) => m.id === currentBucket || m.slug === currentBucket);
  const isOpen = (id: string) => unfolded.includes(id) || holdsCurrent(id);

  let creating = $state(false);
</script>

<div class="flex flex-col gap-px">
  <div class="flex items-center justify-between pr-1">
    <h2 class="px-2 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">Orgs</h2>
    <button
      type="button"
      class="grid size-5 place-items-center rounded text-subtle hover:bg-surface-2 hover:text-text"
      aria-label="New org"
      title="New org"
      onclick={() => (creating = true)}><Plus size={13} /></button
    >
  </div>
  {#each orgs as w (w.id)}
    {@const open = isOpen(w.id)}
    {@const here =
      path === routes.owner(w.handle) || path.startsWith(routes.owner(w.handle) + '/settings')}
    <div
      class="flex h-7 min-w-0 items-center rounded-md {here
        ? 'bg-surface-3'
        : 'hover:bg-surface-2'}"
    >
      <button
        type="button"
        class="grid h-7 w-6 shrink-0 place-items-center text-subtle hover:text-text"
        aria-label="{open ? 'Fold' : 'Unfold'} {w.name}"
        aria-expanded={open}
        onclick={() => fold(w.id)}
      >
        <ChevronRight size={13} class="transition-transform {open ? 'rotate-90' : ''}" />
      </button>
      <a
        href={routes.owner(w.handle)}
        aria-current={here ? 'page' : undefined}
        data-org={w.id}
        class="flex h-7 min-w-0 flex-1 items-center gap-2 pr-2 text-sm
          {here ? 'font-medium text-text' : 'text-muted hover:text-text'}"
      >
        <Indicator of={w} seed={w.id} size="sm" />
        <span class="flex-1 truncate">{w.name}</span>
      </a>
    </div>
    {#if open}
      {#each of(boards, w.id) as b (b.id)}
        <SidebarBoard
          board={b}
          indent
          starred={prefs.get(b.id)?.starred ?? false}
          unread={unread.get(b.id) ?? 0}
          current={b.key === currentKey}
          lastViewId={prefs.get(b.id)?.lastViewId ?? null}
        />
      {/each}
      {#each of(artifacts, w.id) as a (a.id)}
        {@const current = a.id === currentArtifact || a.slug === currentArtifact}
        <a
          href={routes.artifact(a.id)}
          aria-current={current ? 'page' : undefined}
          class="flex h-7 min-w-0 items-center gap-2 rounded-md pr-2 pl-7 text-sm
            {current
            ? 'bg-surface-3 font-medium text-text'
            : 'text-muted hover:bg-surface-2 hover:text-text'}"
        >
          <Indicator of={a} seed={a.id} size="sm" />
          <span class="flex-1 truncate">{a.name}</span>
        </a>
      {/each}
      {#each of(buckets, w.id) as m (m.id)}
        {@const current = m.id === currentBucket || m.slug === currentBucket}
        <a
          href={routes.bucket(m.id)}
          aria-current={current ? 'page' : undefined}
          data-bucket={m.id}
          class="flex h-7 min-w-0 items-center gap-2 rounded-md pr-2 pl-7 text-sm
            {current
            ? 'bg-surface-3 font-medium text-text'
            : 'text-muted hover:bg-surface-2 hover:text-text'}"
        >
          <Indicator of={m} seed={m.id} fallback={BUCKET_DEFAULT_INDICATOR} size="sm" />
          <span class="flex-1 truncate">{m.name}</span>
        </a>
      {/each}
      {#if !of(boards, w.id).length && !of(artifacts, w.id).length && !of(buckets, w.id).length}
        <a
          href={routes.owner(w.handle)}
          class="flex h-7 items-center pl-7 text-xs text-subtle hover:text-text"
          >Empty — create or move things here</a
        >
      {/if}
    {/if}
  {:else}
    {#if !$orgsQ.loading}
      <button
        type="button"
        class="flex h-7 items-center gap-2 rounded-md px-2 text-left text-sm text-muted hover:bg-surface-2 hover:text-text"
        onclick={() => (creating = true)}
      >
        <Plus size={14} class="shrink-0" /> New org
      </button>
    {/if}
  {/each}
</div>

<NewOrgDialog bind:open={creating} />

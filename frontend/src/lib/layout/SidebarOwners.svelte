<!--
  OWNERS in the sidebar (agents.html §AC) — the only place boards, artifacts
  and buckets are listed: each under the person or org that owns it, like
  repos on GitHub. Used twice by the Sidebar:
    — Orgs:  ▸ ● Name  [+]      my orgs, then orgs I only reach a thing of
    — Users: ▸ ◯ Name  [+]      me first, then whoever shares things with me
  A row opens the owner's page (/{handle}); ▸ unfolds what it owns right here.
  The + (my own space, and orgs I am an owner or admin of) makes a board,
  artifact, bucket or dictionary owned there. Groups come from ownerGroups
  (lib/orgs/owners).
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path, so resolve() would be the identity.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { AppWindow, BookA, Brain, ChevronRight, LayoutGrid, Plus } from 'lucide-svelte';
  import type { Artifact, Board, BoardPref, Bucket, Dictionary } from '@tm/shared';
  import { BUCKET_DEFAULT_INDICATOR, DICTIONARY_DEFAULT_INDICATOR } from '@tm/shared';
  import Indicator from '$lib/ui/Indicator.svelte';
  import Menu from '$lib/ui/Menu.svelte';
  import type { MenuItem } from '$lib/ui/types';
  import type { WithId } from '$lib/stores';
  import PersonAvatar from '$lib/orgs/PersonAvatar.svelte';
  import PersonName from '$lib/orgs/PersonName.svelte';
  import NewArtifactDialog from '$lib/artifacts/NewArtifactDialog.svelte';
  import NewBucketDialog from '$lib/bucket/NewBucketDialog.svelte';
  import NewDictionaryDialog from '$lib/dictionary/NewDictionaryDialog.svelte';
  import type { OwnerGroup } from '$lib/orgs/owners';
  import SidebarBoard from './SidebarBoard.svelte';
  import { routes } from './routes';

  type Group = OwnerGroup<WithId<Board>, WithId<Artifact>, WithId<Bucket>, WithId<Dictionary>>;
  interface Props {
    title: 'Orgs' | 'Users';
    groups: readonly Group[];
    prefs: ReadonlyMap<string, BoardPref | null>;
    unread: ReadonlyMap<string, number>;
    path: string;
    currentKey: string | null;
    currentArtifact: string | null;
    currentBucket: string | null;
    currentDictionary?: string | null;
    /** Orgs only: the header's + (a new org). */
    onNewOrg?: (() => void) | null;
  }
  let {
    title,
    groups,
    prefs,
    unread,
    path,
    currentKey,
    currentArtifact,
    currentBucket,
    currentDictionary = null,
    onNewOrg = null,
  }: Props = $props();

  // Starred boards first, then by name — the order the board pages use.
  const boardsOf = (g: Group) =>
    [...g.boards].sort(
      (a, b) =>
        Number(prefs.get(b.id)?.starred ?? false) - Number(prefs.get(a.id)?.starred ?? false) ||
        a.name.localeCompare(b.name),
    );
  const byName = <T extends { name: string }>(list: readonly T[]) =>
    [...list].sort((a, b) => a.name.localeCompare(b.name));

  // Which are unfolded: remembered per browser; the one holding the open item is always open.
  const OPEN_KEY = 'tm.owners.open';
  let unfolded = $state<string[]>(load());
  function load(): string[] {
    try {
      return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]') as string[];
    } catch {
      return [];
    }
  }
  function fold(key: string) {
    unfolded = unfolded.includes(key) ? unfolded.filter((x) => x !== key) : [...unfolded, key];
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(unfolded));
    } catch {
      /* private mode */
    }
  }
  const holdsCurrent = (g: Group) =>
    g.boards.some((b) => b.key === currentKey) ||
    g.artifacts.some((a) => a.id === currentArtifact || a.slug === currentArtifact) ||
    g.buckets.some((m) => m.id === currentBucket || m.slug === currentBucket) ||
    g.dictionaries.some((d) => d.id === currentDictionary || d.slug === currentDictionary);
  // My own space starts unfolded (remembered as folded with a leading '-').
  const isOpen = (g: Group) =>
    (g.me ? !unfolded.includes(`-${g.key}`) : unfolded.includes(g.key)) || holdsCurrent(g);
  const toggle = (g: Group) => fold(g.me ? `-${g.key}` : g.key);

  let newArtifactFor = $state('');
  let newArtifact = $state(false);
  let newBucketFor = $state('');
  let newBucket = $state(false);
  let newDictionaryFor = $state('');
  let newDictionary = $state(false);
  const createItems = (g: Group): MenuItem[] => [
    { label: 'New board', icon: LayoutGrid, href: `${routes.newBoard()}?owner=${g.key}` },
    {
      label: 'New artifact',
      icon: AppWindow,
      onSelect: () => {
        newArtifactFor = g.key;
        newArtifact = true;
      },
    },
    {
      label: 'New bucket',
      icon: Brain,
      onSelect: () => {
        newBucketFor = g.key;
        newBucket = true;
      },
    },
    {
      label: 'New dictionary',
      icon: BookA,
      onSelect: () => {
        newDictionaryFor = g.key;
        newDictionary = true;
      },
    },
  ];
</script>

<div class="flex flex-col gap-px" data-owners={title.toLowerCase()}>
  <div class="flex items-center justify-between pr-1">
    <h2 class="px-2 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">
      {title}
    </h2>
    {#if onNewOrg}
      <button
        type="button"
        class="grid size-5 place-items-center rounded text-subtle hover:bg-surface-2 hover:text-text"
        aria-label="New org"
        title="New org"
        onclick={onNewOrg}><Plus size={13} /></button
      >
    {/if}
  </div>
  {#each groups as g (g.key)}
    {@const open = isOpen(g)}
    {@const href = g.handle ? routes.owner(g.handle) : null}
    {@const here = !!href && (path === href || path.startsWith(href + '/settings'))}
    {@const label = g.name ?? (g.kind === 'org' ? `@${g.handle ?? g.id}` : null)}
    <div
      class="group/row flex h-7 min-w-0 items-center rounded-md {here
        ? 'bg-surface-3'
        : 'hover:bg-surface-2'}"
      data-owner-row={g.key}
    >
      <button
        type="button"
        class="grid h-7 w-6 shrink-0 place-items-center text-subtle hover:text-text"
        aria-label="{open ? 'Fold' : 'Unfold'} {label ?? g.handle ?? 'owner'}"
        aria-expanded={open}
        onclick={() => toggle(g)}
      >
        <ChevronRight size={13} class="transition-transform {open ? 'rotate-90' : ''}" />
      </button>
      <a
        href={href ?? undefined}
        aria-current={here ? 'page' : undefined}
        data-org={g.kind === 'org' ? g.id : undefined}
        data-user={g.kind === 'user' ? g.id : undefined}
        class="flex h-7 min-w-0 flex-1 items-center gap-2 pr-1 text-sm
          {here ? 'font-medium text-text' : 'text-muted hover:text-text'}"
      >
        {#if g.kind === 'org'}
          <Indicator of={g.org} seed={g.id} size="sm" />
        {:else}
          <PersonAvatar uid={g.id} />
        {/if}
        <span class="flex-1 truncate"
          >{#if label}{label}{:else}<PersonName uid={g.id} />{g.me ? ' (you)' : ''}{/if}</span
        >
      </a>
      {#if g.canCreate}
        <Menu items={createItems(g)} placement="bottom-end">
          {#snippet trigger(props)}
            <button
              {...props}
              type="button"
              class="mr-1 grid size-5 shrink-0 place-items-center rounded text-subtle opacity-60 hover:bg-surface-3 hover:text-text hover:opacity-100"
              aria-label="Create in {label ?? 'your space'}"
              title="New board, artifact, bucket or dictionary here"><Plus size={13} /></button
            >
          {/snippet}
        </Menu>
      {/if}
    </div>
    {#if open}
      {#each boardsOf(g) as b (b.id)}
        <SidebarBoard
          board={b}
          indent
          starred={prefs.get(b.id)?.starred ?? false}
          unread={unread.get(b.id) ?? 0}
          current={b.key === currentKey}
          lastViewId={prefs.get(b.id)?.lastViewId ?? null}
        />
      {/each}
      {#each byName(g.artifacts) as a (a.id)}
        {@const current = a.id === currentArtifact || a.slug === currentArtifact}
        <a
          href={routes.artifact(a.id)}
          aria-current={current ? 'page' : undefined}
          data-artifact={a.id}
          class="flex h-7 min-w-0 items-center gap-2 rounded-md pr-2 pl-7 text-sm
            {current
            ? 'bg-surface-3 font-medium text-text'
            : 'text-muted hover:bg-surface-2 hover:text-text'}"
        >
          <Indicator of={a} seed={a.id} size="sm" />
          <span class="flex-1 truncate">{a.name}</span>
        </a>
      {/each}
      {#each byName(g.buckets) as m (m.id)}
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
      {#each byName(g.dictionaries) as d (d.id)}
        {@const current = d.id === currentDictionary || d.slug === currentDictionary}
        <a
          href={routes.dictionary(d.id)}
          aria-current={current ? 'page' : undefined}
          data-dictionary={d.id}
          class="flex h-7 min-w-0 items-center gap-2 rounded-md pr-2 pl-7 text-sm
            {current
            ? 'bg-surface-3 font-medium text-text'
            : 'text-muted hover:bg-surface-2 hover:text-text'}"
        >
          <Indicator of={d} seed={d.id} fallback={DICTIONARY_DEFAULT_INDICATOR} size="sm" />
          <span class="flex-1 truncate">{d.name}</span>
        </a>
      {/each}
      {#if !g.boards.length && !g.artifacts.length && !g.buckets.length && !g.dictionaries.length}
        <span class="flex h-7 items-center pl-7 text-xs text-subtle"
          >{g.canCreate ? 'Empty — use + to create here' : 'Nothing here you can open'}</span
        >
      {/if}
    {/if}
  {:else}
    {#if onNewOrg}
      <button
        type="button"
        class="flex h-7 items-center gap-2 rounded-md px-2 text-left text-sm text-muted hover:bg-surface-2 hover:text-text"
        onclick={onNewOrg}
      >
        <Plus size={14} class="shrink-0" /> New org
      </button>
    {/if}
  {/each}
</div>

<NewArtifactDialog bind:open={newArtifact} owner={newArtifactFor} />
<NewBucketDialog bind:open={newBucket} owner={newBucketFor} />
<NewDictionaryDialog bind:open={newDictionary} owner={newDictionaryFor} />

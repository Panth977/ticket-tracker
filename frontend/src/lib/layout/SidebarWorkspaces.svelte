<!--
  WORKSPACES in the sidebar (agents.html §AB2). One row per workspace — ▸ dot
  Name — which opens its page; ▸ unfolds its boards and artifacts right here.
  Clicking one of those enters the workspace (lib/workspaces/context), so the
  board header and switcher stay inside it. The only fold in the sidebar: a
  workspace is a group of rows that are already one click away elsewhere.
  Boards and artifacts come in from the Sidebar (no second listener).
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path, so resolve() would be the identity.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { ChevronRight, Plus } from 'lucide-svelte';
  import type { Artifact, Board, BoardPref, Memory } from '@tm/shared';
  import Indicator from '$lib/ui/Indicator.svelte';
  import { MEMORY_DEFAULT_INDICATOR } from '@tm/shared';
  import { auth } from '$lib/firebase/auth.svelte';
  import type { WithId } from '$lib/stores';
  import { workspaceContext } from '$lib/workspaces/context.svelte';
  import { myWorkspaces } from '$lib/workspaces/store';
  import WorkspaceDialog from '$lib/workspaces/WorkspaceDialog.svelte';
  import SidebarBoard from './SidebarBoard.svelte';
  import { routes } from './routes';

  interface Props {
    boards: readonly WithId<Board>[];
    artifacts: readonly WithId<Artifact>[];
    memories: readonly WithId<Memory>[];
    prefs: ReadonlyMap<string, BoardPref | null>;
    unread: ReadonlyMap<string, number>;
    path: string;
    currentKey: string | null;
    currentArtifact: string | null;
    currentMemory: string | null;
  }
  let {
    boards,
    artifacts,
    memories,
    prefs,
    unread,
    path,
    currentKey,
    currentArtifact,
    currentMemory,
  }: Props = $props();

  const wsQ = $derived(myWorkspaces(auth.uid));
  const boardById = $derived(new Map(boards.map((b) => [b.id, b])));
  const artifactById = $derived(new Map(artifacts.map((a) => [a.id, a])));
  const memoryById = $derived(new Map(memories.map((m) => [m.id, m])));

  // Which are unfolded: remembered per browser; the one I am in is always open.
  const OPEN_KEY = 'tm.workspaces.open';
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
  const isOpen = (id: string) => unfolded.includes(id) || workspaceContext.id === id;

  let creating = $state(false);
</script>

<div class="flex flex-col gap-px">
  <div class="flex items-center justify-between pr-1">
    <h2 class="px-2 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">
      Workspaces
    </h2>
    <button
      type="button"
      class="grid size-5 place-items-center rounded text-subtle hover:bg-surface-2 hover:text-text"
      aria-label="New workspace"
      title="New workspace"
      onclick={() => (creating = true)}><Plus size={13} /></button
    >
  </div>
  {#each $wsQ.data as w (w.id)}
    {@const open = isOpen(w.id)}
    {@const here = path === routes.workspace(w.id)}
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
        href={routes.workspace(w.id)}
        onclick={() => workspaceContext.enter(w.id)}
        aria-current={here ? 'page' : undefined}
        data-workspace={w.id}
        class="flex h-7 min-w-0 flex-1 items-center gap-2 pr-2 text-sm
          {here ? 'font-medium text-text' : 'text-muted hover:text-text'}"
      >
        <Indicator of={w} seed={w.id} size="sm" />
        <span class="flex-1 truncate">{w.name}</span>
      </a>
    </div>
    {#if open}
      {#each w.boardIds as id (id)}
        {@const b = boardById.get(id)}
        {#if b}
          <SidebarBoard
            board={b}
            indent
            starred={prefs.get(b.id)?.starred ?? false}
            unread={unread.get(b.id) ?? 0}
            current={workspaceContext.id === w.id && b.key === currentKey}
            lastViewId={prefs.get(b.id)?.lastViewId ?? null}
            onclick={() => workspaceContext.enter(w.id)}
          />
        {/if}
      {/each}
      {#each w.artifactIds as id (id)}
        {@const a = artifactById.get(id)}
        {#if a}
          {@const current = workspaceContext.id === w.id && a.id === currentArtifact}
          <a
            href={routes.artifact(a.id)}
            onclick={() => workspaceContext.enter(w.id)}
            aria-current={current ? 'page' : undefined}
            class="flex h-7 min-w-0 items-center gap-2 rounded-md pr-2 pl-7 text-sm
              {current
              ? 'bg-surface-3 font-medium text-text'
              : 'text-muted hover:bg-surface-2 hover:text-text'}"
          >
            <Indicator of={a} seed={a.id} size="sm" />
            <span class="flex-1 truncate">{a.name}</span>
          </a>
        {/if}
      {/each}
      {#each w.memoryIds ?? [] as id (id)}
        {@const m = memoryById.get(id)}
        {#if m}
          {@const current = workspaceContext.id === w.id && m.id === currentMemory}
          <a
            href={routes.memory(m.id)}
            onclick={() => workspaceContext.enter(w.id)}
            aria-current={current ? 'page' : undefined}
            data-memory={m.id}
            class="flex h-7 min-w-0 items-center gap-2 rounded-md pr-2 pl-7 text-sm
              {current
              ? 'bg-surface-3 font-medium text-text'
              : 'text-muted hover:bg-surface-2 hover:text-text'}"
          >
            <Indicator of={m} seed={m.id} fallback={MEMORY_DEFAULT_INDICATOR} size="sm" />
            <span class="flex-1 truncate">{m.name}</span>
          </a>
        {/if}
      {/each}
      {#if !w.boardIds.some( (id) => boardById.has(id) ) && !w.artifactIds.some( (id) => artifactById.has(id) ) && !(w.memoryIds ?? []).some( (id) => memoryById.has(id) )}
        <a
          href={routes.workspace(w.id)}
          class="flex h-7 items-center pl-7 text-xs text-subtle hover:text-text"
          >Empty — add boards</a
        >
      {/if}
    {/if}
  {:else}
    {#if !$wsQ.loading}
      <button
        type="button"
        class="flex h-7 items-center gap-2 rounded-md px-2 text-left text-sm text-muted hover:bg-surface-2 hover:text-text"
        onclick={() => (creating = true)}
      >
        <Plus size={14} class="shrink-0" /> New workspace
      </button>
    {/if}
  {/each}
</div>

<WorkspaceDialog bind:open={creating} />

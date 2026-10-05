<!--
  /w/{id} — one of my workspaces (agents.html §AB): its boards as tiles and its
  artifacts as rows, on one page. Being here enters the workspace, so a board
  opened from it keeps "Workspace › Board" and the workspace-only switcher.
  Edit (name, colour, what is in it), remove one item, hide items from the
  sidebar's root, or delete the workspace — nothing it holds is touched.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Eye, EyeOff, Pencil, Trash2, X } from 'lucide-svelte';
  import { paths, type Workspace } from '@tm/shared';
  import { command } from '$lib/api';
  import BoardTile from '$lib/account/BoardTile.svelte';
  import { artifactGlyph, myArtifacts, splitArtifacts } from '$lib/artifacts/store';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { docStore, myBoards } from '$lib/stores';
  import { Button, EmptyState, Skeleton } from '$lib/ui';
  import { workspaceContext } from '$lib/workspaces/context.svelte';
  import { hiddenItems, setHidden } from '$lib/workspaces/store';
  import WorkspaceDialog from '$lib/workspaces/WorkspaceDialog.svelte';

  const uid = $derived(auth.uid);
  const id = $derived(page.params.workspaceId ?? '');
  const wsQ = $derived(docStore<Workspace>(uid && id ? paths.workspace(uid, id) : null));
  const ws = $derived($wsQ.data ? { ...$wsQ.data, id } : null);

  const boardsQ = $derived(myBoards(uid));
  const artifactsQ = $derived(myArtifacts(uid));
  const hiddenQ = $derived(hiddenItems(uid));

  // In its order; ones I can no longer open (or archived) simply are not shown.
  const boards = $derived.by(() => {
    const byId = new Map($boardsQ.data.filter((b) => b.archivedAt == null).map((b) => [b.id, b]));
    return (ws?.boardIds ?? []).flatMap((x) => byId.get(x) ?? []);
  });
  const artifacts = $derived.by(() => {
    const byId = new Map(splitArtifacts($artifactsQ.data).active.map((a) => [a.id, a]));
    return (ws?.artifactIds ?? []).flatMap((x) => byId.get(x) ?? []);
  });

  $effect(() => {
    if (ws) workspaceContext.enter(ws.id);
  });

  let editing = $state(false);
  let confirmDelete = $state(false);
  let busy = $state(false);

  async function remove(item: { boardIds: string[] } | { artifactIds: string[] }) {
    if (!ws) return;
    try {
      await command(
        'workspaceUpdate',
        { workspaceId: ws.id, remove: item },
        { toast: 'Could not update the workspace' },
      );
    } catch {
      /* toasted */
    }
  }

  async function del() {
    if (!ws || busy) return;
    busy = true;
    try {
      await command('workspaceDelete', { workspaceId: ws.id }, { toast: 'Could not delete it' });
      workspaceContext.leave();
      await goto(routes.home());
    } catch {
      busy = false;
    }
  }
</script>

<svelte:head><title>{ws?.name ?? 'Workspace'} · TaskManager</title></svelte:head>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8">
  {#if $wsQ.loading}
    <Skeleton width="40%" height="2rem" />
  {:else if !ws}
    <EmptyState
      title="Workspace not found"
      description="It may have been deleted. Your boards and artifacts are all still on the All pages."
    >
      {#snippet action()}<Button href={routes.home()}>All boards</Button>{/snippet}
    </EmptyState>
  {:else}
    <header class="flex flex-wrap items-center justify-between gap-4">
      <div class="flex min-w-0 items-center gap-3">
        <span class="size-3 shrink-0 rounded-full" style="background: {ws.color}"></span>
        <h1 class="truncate text-2xl font-semibold">{ws.name}</h1>
      </div>
      <div class="flex items-center gap-2">
        <Button icon={Pencil} onclick={() => (editing = true)}>Edit</Button>
        {#if confirmDelete}
          <Button variant="danger" loading={busy} onclick={del}>Delete workspace</Button>
          <Button variant="ghost" onclick={() => (confirmDelete = false)}>Keep</Button>
        {:else}
          <Button variant="ghost" icon={Trash2} onclick={() => (confirmDelete = true)}
            >Delete</Button
          >
        {/if}
      </div>
    </header>
    {#if confirmDelete}
      <p class="-mt-4 text-sm text-muted">
        Only the grouping goes. Its boards and artifacts stay exactly as they are.
      </p>
    {/if}

    {#if !boards.length && !artifacts.length}
      <EmptyState
        title="Nothing here yet"
        description="Add boards and artifacts you already have. They stay where they are too; this just keeps them together."
      >
        {#snippet action()}
          <Button variant="primary" onclick={() => (editing = true)}>Add boards & artifacts</Button>
        {/snippet}
      </EmptyState>
    {/if}

    {#if boards.length}
      <section aria-label="Boards" class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold tracking-wide text-subtle uppercase">Boards</h2>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {#each boards as b (b.id)}
            <BoardTile
              board={b}
              uid={uid ?? ''}
              hidden={$hiddenQ}
              onremove={() => remove({ boardIds: [b.id] })}
              onopen={() => workspaceContext.enter(ws.id)}
            />
          {/each}
        </div>
      </section>
    {/if}

    {#if artifacts.length}
      <section aria-label="Artifacts" class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold tracking-wide text-subtle uppercase">Artifacts</h2>
        <ul class="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {#each artifacts as a (a.id)}
            {@const isHidden = $hiddenQ.artifacts.has(a.id)}
            <li class="group flex items-center hover:bg-surface-2">
              <a
                href={routes.artifact(a.id)}
                onclick={() => workspaceContext.enter(ws.id)}
                class="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4"
                data-artifact={a.id}
              >
                <span class="w-6 shrink-0 text-center text-lg leading-none" aria-hidden="true"
                  >{artifactGlyph(a)}</span
                >
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium">{a.name}</span>
                  {#if a.description}<span class="block truncate text-sm text-muted"
                      >{a.description}</span
                    >{/if}
                </span>
                {#if isHidden}<span class="text-xs text-subtle">hidden from sidebar</span>{/if}
              </a>
              {#if uid}
                <button
                  type="button"
                  class="rounded p-1.5 transition-colors {isHidden
                    ? 'text-muted'
                    : 'text-subtle opacity-0 group-hover:opacity-100 focus-visible:opacity-100'} hover:text-text"
                  aria-label={isHidden
                    ? `Show ${a.name} in the sidebar`
                    : `Hide ${a.name} from the sidebar`}
                  aria-pressed={isHidden}
                  onclick={() => setHidden(uid, $hiddenQ, { artifactId: a.id }, !isHidden, a.name)}
                >
                  {#if isHidden}<EyeOff size={16} aria-hidden="true" />{:else}<Eye
                      size={16}
                      aria-hidden="true"
                    />{/if}
                </button>
              {/if}
              <button
                type="button"
                class="mr-2 rounded p-1.5 text-subtle opacity-0 transition-colors group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                aria-label="Remove {a.name} from this workspace"
                onclick={() => remove({ artifactIds: [a.id] })}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</div>

{#if ws}<WorkspaceDialog bind:open={editing} workspace={ws} />{/if}

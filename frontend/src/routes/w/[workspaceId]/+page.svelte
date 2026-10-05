<!--
  /w/{id} — one of my workspaces (agents.html §AB): its boards, artifacts and
  memories as cards, on one page. Being here enters the workspace, so one
  opened from it keeps "Workspace › Name" and the workspace-only switcher.
  Edit (name, colour, what is in it), remove one item, or delete the
  workspace — nothing it holds is touched. NO hide / show here: hiding is
  about the sidebar's root lists, and this page is not one of them.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Pencil, Trash2 } from 'lucide-svelte';
  import { memoryGlyph, paths, type Workspace } from '@tm/shared';
  import { command } from '$lib/api';
  import BoardTile from '$lib/account/BoardTile.svelte';
  import { artifactGlyph, myArtifacts, splitArtifacts } from '$lib/artifacts/store';
  import { auth } from '$lib/firebase/auth.svelte';
  import ItemTile from '$lib/layout/ItemTile.svelte';
  import { routes } from '$lib/layout/routes';
  import { myMemories, splitMemories } from '$lib/memory/store';
  import { docStore, myBoards } from '$lib/stores';
  import { Button, EmptyState, Skeleton } from '$lib/ui';
  import { workspaceContext } from '$lib/workspaces/context.svelte';
  import WorkspaceDialog from '$lib/workspaces/WorkspaceDialog.svelte';

  const uid = $derived(auth.uid);
  const id = $derived(page.params.workspaceId ?? '');
  const wsQ = $derived(docStore<Workspace>(uid && id ? paths.workspace(uid, id) : null));
  const ws = $derived($wsQ.data ? { ...$wsQ.data, id } : null);

  const boardsQ = $derived(myBoards(uid));
  const artifactsQ = $derived(myArtifacts(uid));
  const memoriesQ = $derived(myMemories(uid));

  // In its order; ones I can no longer open (or archived) simply are not shown.
  const boards = $derived.by(() => {
    const byId = new Map($boardsQ.data.filter((b) => b.archivedAt == null).map((b) => [b.id, b]));
    return (ws?.boardIds ?? []).flatMap((x) => byId.get(x) ?? []);
  });
  const artifacts = $derived.by(() => {
    const byId = new Map(splitArtifacts($artifactsQ.data).active.map((a) => [a.id, a]));
    return (ws?.artifactIds ?? []).flatMap((x) => byId.get(x) ?? []);
  });
  const memories = $derived.by(() => {
    const byId = new Map(splitMemories($memoriesQ.data).active.map((m) => [m.id, m]));
    return (ws?.memoryIds ?? []).flatMap((x) => byId.get(x) ?? []);
  });

  $effect(() => {
    if (ws) workspaceContext.enter(ws.id);
  });

  let editing = $state(false);
  let confirmDelete = $state(false);
  let busy = $state(false);

  async function remove(
    item: { boardIds: string[] } | { artifactIds: string[] } | { memoryIds: string[] },
  ) {
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
        Only the grouping goes. Its boards, artifacts and memories stay exactly as they are.
      </p>
    {/if}

    {#if !boards.length && !artifacts.length && !memories.length}
      <EmptyState
        title="Nothing here yet"
        description="Add boards, artifacts and memories you already have. They stay where they are too; this just keeps them together."
      >
        {#snippet action()}
          <Button variant="primary" onclick={() => (editing = true)}>Add to this workspace</Button>
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
        <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {#each artifacts as a (a.id)}
            <ItemTile
              dataKind="artifact"
              id={a.id}
              href={routes.artifact(a.id)}
              name={a.name}
              glyph={artifactGlyph(a)}
              description={a.description}
              onremove={() => remove({ artifactIds: [a.id] })}
              onopen={() => workspaceContext.enter(ws.id)}
            />
          {/each}
        </div>
      </section>
    {/if}

    {#if memories.length}
      <section aria-label="Memory" class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold tracking-wide text-subtle uppercase">Memory</h2>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {#each memories as m (m.id)}
            <ItemTile
              dataKind="memory"
              id={m.id}
              href={routes.memory(m.id)}
              name={m.name}
              glyph={memoryGlyph(m)}
              description={m.description}
              onremove={() => remove({ memoryIds: [m.id] })}
              onopen={() => workspaceContext.enter(ws.id)}
            >
              {#snippet meta()}
                <span>{m.stats.files} {m.stats.files === 1 ? 'file' : 'files'}</span>
              {/snippet}
            </ItemTile>
          {/each}
        </div>
      </section>
    {/if}
  {/if}
</div>

{#if ws}<WorkspaceDialog bind:open={editing} workspace={ws} />{/if}

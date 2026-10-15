<!--
  /{handle} (rerouted here, hooks.ts) — an OWNER's page (agents.html §AC): a
  person or an org, and everything of theirs I can open. An org's page also
  offers its settings (members, base role, env) to its owners and admins,
  and new boards / artifacts / buckets made right inside it.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { Plus, Settings } from 'lucide-svelte';
  import { BUCKET_DEFAULT_INDICATOR } from '@tm/shared';
  import { command } from '$lib/api';
  import BoardTile from '$lib/account/BoardTile.svelte';
  import { myArtifacts, splitArtifacts } from '$lib/artifacts/store';
  import { myBuckets, splitBuckets } from '$lib/bucket/store';
  import { auth } from '$lib/firebase/auth.svelte';
  import ItemTile from '$lib/layout/ItemTile.svelte';
  import { routes } from '$lib/layout/routes';
  import { orgDoc } from '$lib/orgs/store';
  import { myBoards } from '$lib/stores';
  import { Button, EmptyState, Skeleton } from '$lib/ui';
  import Indicator from '$lib/ui/Indicator.svelte';

  const handle = $derived((page.params.handle ?? '').toLowerCase());
  type Resolved = Awaited<ReturnType<typeof command<'pathResolve'>>>;
  let who = $state<Resolved | null>(null);
  let missing = $state(false);
  $effect(() => {
    const h = handle;
    who = null;
    missing = false;
    command('pathResolve', { handle: h })
      .then((r) => (who = r))
      .catch(() => (missing = true));
  });

  const orgQ = $derived(orgDoc(who?.owner.kind === 'org' ? who.owner.id : null));
  const myRole = $derived($orgQ.data?.members[auth.uid ?? ''] ?? null);
  const key = $derived(who ? `${who.owner.kind}:${who.owner.id}` : '');
  const ownedBy = <T extends { ownerKey?: string | null; ownerUid?: string; createdBy?: string }>(
    t: T,
  ) =>
    t.ownerKey === key ||
    (!t.ownerKey && who?.owner.kind === 'user' && (t.ownerUid ?? t.createdBy) === who.owner.id);

  const boardsQ = $derived(myBoards(auth.uid));
  const artifactsQ = $derived(myArtifacts(auth.uid));
  const bucketsQ = $derived(myBuckets(auth.uid));
  const boards = $derived($boardsQ.data.filter((b) => b.archivedAt == null && ownedBy(b)));
  const artifacts = $derived(splitArtifacts($artifactsQ.data).active.filter(ownedBy));
  const buckets = $derived(splitBuckets($bucketsQ.data).active.filter(ownedBy));
  const canCreate = $derived(who?.owner.kind === 'org' ? !!myRole : who?.owner.id === auth.uid);
</script>

<svelte:head><title>{who?.name ?? handle} · TaskManager</title></svelte:head>

<div
  class="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8"
  data-owner-page={handle}
>
  {#if missing}
    <EmptyState title="Nobody here" description="No person or org goes by “{handle}”.">
      {#snippet action()}<Button href={routes.home()}>All boards</Button>{/snippet}
    </EmptyState>
  {:else if !who}
    <Skeleton width="40%" height="2rem" />
  {:else}
    <header class="flex flex-wrap items-center justify-between gap-4">
      <div class="flex min-w-0 items-center gap-3">
        {#if $orgQ.data}<Indicator of={$orgQ.data} seed={who.owner.id} size="lg" />{/if}
        <div class="min-w-0">
          <h1 class="truncate text-2xl font-semibold">{who.name}</h1>
          <p class="text-sm text-muted">
            @{who.handle} · {who.owner.kind === 'org' ? 'Org' : 'Person'}
            {#if myRole}· you are {myRole === 'member' ? 'a member' : `an ${myRole}`}{/if}
          </p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        {#if canCreate}
          <Button icon={Plus} href={`${routes.newBoard()}?owner=${who.owner.kind}:${who.owner.id}`}
            >New board</Button
          >
        {/if}
        {#if myRole === 'owner' || myRole === 'admin'}
          <Button icon={Settings} href={routes.orgSettings(who.handle)}>Settings</Button>
        {/if}
      </div>
    </header>

    {#if !boards.length && !artifacts.length && !buckets.length}
      <EmptyState
        title="Nothing here you can open"
        description={who.owner.kind === 'org'
          ? 'Create a board inside it, or move one here from its settings (Danger zone › Move).'
          : 'Things this person shares with you show up here.'}
      />
    {/if}

    {#if boards.length}
      <section aria-label="Boards" class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold tracking-wide text-subtle uppercase">Boards</h2>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {#each boards as b (b.id)}
            <BoardTile board={b} uid={auth.uid ?? ''} />
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
              of={a}
              description={a.description}
            />
          {/each}
        </div>
      </section>
    {/if}
    {#if buckets.length}
      <section aria-label="Buckets" class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold tracking-wide text-subtle uppercase">Buckets</h2>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {#each buckets as m (m.id)}
            <ItemTile
              dataKind="bucket"
              id={m.id}
              href={routes.bucket(m.id)}
              name={m.name}
              of={m}
              fallback={BUCKET_DEFAULT_INDICATOR}
              description={m.description}
            />
          {/each}
        </div>
      </section>
    {/if}
  {/if}
</div>

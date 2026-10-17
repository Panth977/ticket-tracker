<!--
  /{handle} (rerouted here, hooks.ts) — an OWNER's page (agents.html §AC), the
  one list of things there is, like a GitHub profile: a person or an org, and
  everything of theirs I can open — boards, artifacts, buckets, dictionaries, then the
  archived ones. On my own page also my pending invitations. Where I may
  create (my own space; an org I am an owner or admin of) it offers New
  board / artifact / bucket / dictionary made right there; an org's owners and admins
  also get its Settings. `/`, `/x` and `/bucket` land on my own page.
-->
<script lang="ts">
  import { APP_NAME } from '$lib/brand';
  // hrefs are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { page } from '$app/state';
  import { AppWindow, Archive, BookA, Brain, LayoutGrid, Plus, Settings } from 'lucide-svelte';
  import { BUCKET_DEFAULT_INDICATOR, DICTIONARY_DEFAULT_INDICATOR } from '@tm/shared';
  import { command } from '$lib/api';
  import BoardTile from '$lib/account/BoardTile.svelte';
  import InviteCard from '$lib/account/InviteCard.svelte';
  import { relativeTime } from '$lib/account/format';
  import NewArtifactDialog from '$lib/artifacts/NewArtifactDialog.svelte';
  import { myArtifacts, roleIn, splitArtifacts } from '$lib/artifacts/store';
  import NewBucketDialog from '$lib/bucket/NewBucketDialog.svelte';
  import { bucketRoleIn, myBuckets, splitBuckets } from '$lib/bucket/store';
  import NewDictionaryDialog from '$lib/dictionary/NewDictionaryDialog.svelte';
  import { dictionaryRoleIn, myDictionaries, splitDictionaries } from '$lib/dictionary/store';
  import { auth } from '$lib/firebase/auth.svelte';
  import ItemTile from '$lib/layout/ItemTile.svelte';
  import { routes } from '$lib/layout/routes';
  import { orgDoc, ownerKeyOfThing } from '$lib/orgs/store';
  import PersonAvatar from '$lib/orgs/PersonAvatar.svelte';
  import { myBoards, myInvites } from '$lib/stores';
  import { Button, EmptyState, Skeleton, toast } from '$lib/ui';
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

  const uid = $derived(auth.uid ?? '');
  const orgQ = $derived(orgDoc(who?.owner.kind === 'org' ? who.owner.id : null));
  const myRole = $derived($orgQ.data?.members[uid] ?? null);
  const mine = $derived(who?.owner.kind === 'user' && who.owner.id === uid);
  const key = $derived(who ? `${who.owner.kind}:${who.owner.id}` : '');
  const ownedBy = (t: { ownerKey?: string | null; ownerUid?: string; createdBy?: string }) =>
    ownerKeyOfThing(t) === key;
  // Where a + makes sense: my own space, and an org I run.
  const canCreate = $derived(mine || myRole === 'owner' || myRole === 'admin');

  const boardsQ = $derived(myBoards(auth.uid));
  const artifactsQ = $derived(myArtifacts(auth.uid));
  const bucketsQ = $derived(myBuckets(auth.uid));
  const dictionariesQ = $derived(myDictionaries(auth.uid));
  const owned = $derived($boardsQ.data.filter(ownedBy));
  const boards = $derived(
    owned.filter((b) => b.archivedAt == null).sort((a, b) => a.name.localeCompare(b.name)),
  );
  const archivedBoards = $derived(owned.filter((b) => b.archivedAt != null));
  const artifactGroups = $derived(splitArtifacts($artifactsQ.data.filter(ownedBy)));
  const bucketGroups = $derived(splitBuckets($bucketsQ.data.filter(ownedBy)));
  const dictionaryGroups = $derived(splitDictionaries($dictionariesQ.data.filter(ownedBy)));
  const archivedCount = $derived(
    archivedBoards.length +
      artifactGroups.archived.length +
      bucketGroups.archived.length +
      dictionaryGroups.archived.length,
  );
  const loading = $derived(
    $boardsQ.loading || $artifactsQ.loading || $bucketsQ.loading || $dictionariesQ.loading,
  );

  const invitesQ = $derived(myInvites(auth.user?.emailVerified ? auth.user.email : null));
  const invites = $derived(mine ? $invitesQ.data.filter((i) => i.expiresAt > Date.now()) : []);

  let newArtifact = $state(false);
  let newBucket = $state(false);
  let newDictionary = $state(false);

  let restoring = $state<string | null>(null);
  async function restore(boardId: string, name: string) {
    restoring = boardId;
    try {
      await command(
        'boardArchive',
        { boardId, action: 'restore' },
        { toast: 'Could not restore the board' },
      );
      toast.success(`${name} is back`);
    } catch {
      /* toasted */
    } finally {
      restoring = null;
    }
  }
  const ROLE: Record<string, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
</script>

<svelte:head><title>{who?.name ?? handle} · {APP_NAME}</title></svelte:head>

<div
  class="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8"
  data-owner-page={handle}
>
  {#if missing}
    <EmptyState title="Nobody here" description="No person or org goes by “{handle}”.">
      {#snippet action()}<Button href={routes.home()}>Your space</Button>{/snippet}
    </EmptyState>
  {:else if !who}
    <Skeleton width="40%" height="2rem" />
  {:else}
    <header class="flex flex-wrap items-center justify-between gap-4">
      <div class="flex min-w-0 items-center gap-3">
        {#if $orgQ.data}<Indicator
            of={$orgQ.data}
            seed={who.owner.id}
            size="lg"
          />{:else if who.owner.kind === 'user'}<PersonAvatar uid={who.owner.id} size={40} />{/if}
        <div class="min-w-0">
          <h1 class="truncate text-2xl font-semibold">{who.name}</h1>
          <p class="text-sm text-muted">
            @{who.handle} · {who.owner.kind === 'org' ? 'Org' : mine ? 'You' : 'Person'}
            {#if myRole}· you are {myRole === 'member' ? 'a member' : `an ${myRole}`}{/if}
          </p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        {#if canCreate}
          <Button
            variant="primary"
            icon={Plus}
            href={`${routes.newBoard()}?owner=${who.owner.kind}:${who.owner.id}`}>New board</Button
          >
          <Button icon={AppWindow} onclick={() => (newArtifact = true)}>New artifact</Button>
          <Button icon={Brain} onclick={() => (newBucket = true)}>New bucket</Button>
          <Button icon={BookA} onclick={() => (newDictionary = true)}>New dictionary</Button>
        {/if}
        {#if myRole === 'owner' || myRole === 'admin'}
          <Button icon={Settings} href={routes.orgSettings(who.handle)}>Settings</Button>
        {/if}
      </div>
    </header>

    {#if invites.length}
      <section class="flex flex-col gap-2" aria-labelledby="inv-h">
        <h2 id="inv-h" class="text-sm font-semibold text-muted">Invitations</h2>
        {#each invites as inv (inv.id)}
          <InviteCard invite={inv} />
        {/each}
      </section>
    {/if}

    {#if loading}
      <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {#each [1, 2, 3] as i (i)}<Skeleton height="7rem" class="rounded-xl" />{/each}
      </div>
    {:else if !boards.length && !artifactGroups.active.length && !bucketGroups.active.length && !dictionaryGroups.active.length}
      <EmptyState
        icon={LayoutGrid}
        title={canCreate ? 'Nothing here yet' : 'Nothing here you can open'}
        description={canCreate
          ? 'Create a board, an artifact, a bucket or a dictionary here — or move one in from its settings (Danger zone › Move).'
          : who.owner.kind === 'org'
            ? 'Ask an owner of this org to add you, or to share something with you.'
            : 'Things this person shares with you show up here.'}
      />
    {/if}

    {#if boards.length}
      <section aria-label="Boards" class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold tracking-wide text-subtle uppercase">Boards</h2>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {#each boards as b (b.id)}
            <BoardTile board={b} {uid} />
          {/each}
        </div>
      </section>
    {/if}
    {#if artifactGroups.active.length}
      <section aria-label="Artifacts" class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold tracking-wide text-subtle uppercase">Artifacts</h2>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {#each artifactGroups.active as a (a.id)}
            {@const role = roleIn(a, uid)}
            <ItemTile
              dataKind="artifact"
              id={a.id}
              href={routes.artifact(a.id)}
              name={a.name}
              of={a}
              description={a.description}
              badge={role ? ROLE[role] : null}
            >
              {#snippet meta()}
                <span
                  >{#if !a.currentBuild}not published{:else}{relativeTime(a.updatedAt)}{/if}</span
                >
              {/snippet}
            </ItemTile>
          {/each}
        </div>
      </section>
    {/if}
    {#if bucketGroups.active.length}
      <section aria-label="Buckets" class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold tracking-wide text-subtle uppercase">Buckets</h2>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {#each bucketGroups.active as m (m.id)}
            {@const role = bucketRoleIn(m, uid)}
            <ItemTile
              dataKind="bucket"
              id={m.id}
              href={routes.bucket(m.id)}
              name={m.name}
              of={m}
              fallback={BUCKET_DEFAULT_INDICATOR}
              description={m.description}
              badge={role ? ROLE[role] : null}
            />
          {/each}
        </div>
      </section>
    {/if}

    {#if dictionaryGroups.active.length}
      <section aria-label="Dictionaries" class="flex flex-col gap-3">
        <h2 class="text-sm font-semibold tracking-wide text-subtle uppercase">Dictionaries</h2>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {#each dictionaryGroups.active as d (d.id)}
            {@const role = dictionaryRoleIn(d, uid)}
            <ItemTile
              dataKind="dictionary"
              id={d.id}
              href={routes.dictionary(d.id)}
              name={d.name}
              of={d}
              fallback={DICTIONARY_DEFAULT_INDICATOR}
              description={d.description}
              badge={role ? ROLE[role] : null}
            >
              {#snippet meta()}
                <span>{d.stats.entries} {d.stats.entries === 1 ? 'entry' : 'entries'}</span>
              {/snippet}
            </ItemTile>
          {/each}
        </div>
      </section>
    {/if}

    {#if archivedCount}
      <details class="group rounded-xl border border-line bg-surface" data-archived>
        <summary
          class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted select-none"
        >
          <Archive size={16} aria-hidden="true" /> Archived
          <span class="text-subtle">({archivedCount})</span>
        </summary>
        <ul class="divide-y divide-line border-t border-line">
          {#each archivedBoards as b (b.id)}
            <li class="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span class="font-mono text-xs text-muted">{b.key}</span>
              <a class="flex-1 truncate text-sm hover:underline" href={routes.board(b.key)}
                >{b.name}</a
              >
              <span class="text-xs text-subtle"
                >board · archived {relativeTime(b.archivedAt ?? 0)}</span
              >
              {#if b.access[uid] === 'admin'}
                <Button
                  size="sm"
                  variant="ghost"
                  loading={restoring === b.id}
                  onclick={() => restore(b.id, b.name)}>Restore</Button
                >
              {/if}
            </li>
          {/each}
          {#each artifactGroups.archived as a (a.id)}
            <li class="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <Indicator of={a} seed={a.id} size="sm" />
              <a
                class="flex-1 truncate text-sm hover:underline"
                href={routes.artifact(a.id)}
                data-artifact={a.id}>{a.name}</a
              >
              <span class="text-xs text-subtle"
                >artifact · archived {relativeTime(a.archivedAt ?? 0)}</span
              >
            </li>
          {/each}
          {#each bucketGroups.archived as m (m.id)}
            <li class="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <Indicator of={m} seed={m.id} fallback={BUCKET_DEFAULT_INDICATOR} size="sm" />
              <a
                class="flex-1 truncate text-sm hover:underline"
                href={routes.bucket(m.id)}
                data-bucket={m.id}>{m.name}</a
              >
              <span class="text-xs text-subtle"
                >bucket · archived {relativeTime(m.archivedAt ?? 0)}</span
              >
            </li>
          {/each}
          {#each dictionaryGroups.archived as d (d.id)}
            <li class="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <Indicator of={d} seed={d.id} fallback={DICTIONARY_DEFAULT_INDICATOR} size="sm" />
              <a
                class="flex-1 truncate text-sm hover:underline"
                href={routes.dictionary(d.id)}
                data-dictionary={d.id}>{d.name}</a
              >
              <span class="text-xs text-subtle"
                >dictionary · archived {relativeTime(d.archivedAt ?? 0)}</span
              >
            </li>
          {/each}
        </ul>
      </details>
    {/if}
  {/if}
</div>

{#if who}
  <NewArtifactDialog bind:open={newArtifact} owner={key} />
  <NewBucketDialog bind:open={newBucket} owner={key} />
  <NewDictionaryDialog bind:open={newDictionary} owner={key} />
{/if}

<!--
  /x — All artifacts (docs/plan/artifacts.html §F): every artifact I have a
  role on, with who owns it, what I may do and when it last changed; archived
  ones in their own group, as the Boards page does. The sidebar shows the same
  list without the detail.
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { AppWindow, Archive, Eye, EyeOff, Plus } from 'lucide-svelte';
  import type { Artifact, ArtifactRole } from '@tm/shared';
  import { relativeTime } from '$lib/account/format';
  import NewArtifactDialog from '$lib/artifacts/NewArtifactDialog.svelte';
  import { artifactGlyph, myArtifacts, roleIn, splitArtifacts } from '$lib/artifacts/store';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { Principal } from '$lib/people';
  import type { WithId } from '$lib/stores';
  import { Button, EmptyState, Skeleton } from '$lib/ui';
  import { workspaceContext } from '$lib/workspaces/context.svelte';
  import { hiddenItems, setHidden } from '$lib/workspaces/store';

  const uid = $derived(auth.uid);
  const q = $derived(myArtifacts(uid));
  const groups = $derived(splitArtifacts($q.data));
  let creating = $state(false);
  const hiddenQ = $derived(hiddenItems(uid));

  const ROLE_LABEL: Record<ArtifactRole, string> = {
    owner: 'Owner',
    editor: 'Editor',
    viewer: 'Viewer',
  };
</script>

<svelte:head><title>Artifacts · TaskManager</title></svelte:head>

{#snippet row(a: WithId<Artifact>)}
  {@const role = roleIn(a, uid)}
  {@const isHidden = $hiddenQ.artifacts.has(a.id)}
  <li class="group flex items-center hover:bg-surface-2">
    <a
      href={routes.artifact(a.id)}
      onclick={() => workspaceContext.leave()}
      class="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 py-3 pl-4"
      data-artifact={a.id}
    >
      <span class="w-6 shrink-0 text-center text-lg leading-none" aria-hidden="true"
        >{artifactGlyph(a)}</span
      >
      <span class="min-w-0 flex-1 basis-48">
        <span class="block truncate font-medium">{a.name}</span>
        {#if a.description}<span class="block truncate text-sm text-muted">{a.description}</span
          >{/if}
      </span>
      <span class="flex w-44 shrink-0 items-center gap-1.5 text-sm text-muted">
        {#if a.ownerUid === uid}You{:else}<Principal id={a.ownerUid} layout="inline" />{/if}
      </span>
      <span class="w-16 shrink-0 text-sm text-muted">{role ? ROLE_LABEL[role] : ''}</span>
      <span class="w-28 shrink-0 text-right text-xs text-subtle">
        {#if a.archivedAt != null}archived {relativeTime(a.archivedAt)}{:else if !a.currentBuild}not
          published{:else}{relativeTime(a.updatedAt)}{/if}
        {#if isHidden}<span class="block">hidden from sidebar</span>{/if}
      </span>
    </a>
    {#if a.archivedAt == null && uid}
      <button
        type="button"
        class="mx-2 rounded p-1.5 transition-colors {isHidden
          ? 'text-muted'
          : 'text-subtle opacity-0 group-hover:opacity-100 focus-visible:opacity-100'} hover:text-text"
        aria-label={isHidden ? `Show ${a.name} in the sidebar` : `Hide ${a.name} from the sidebar`}
        title={isHidden ? 'Hidden from the sidebar — show it again' : 'Hide from the sidebar'}
        aria-pressed={isHidden}
        data-hide-toggle
        onclick={() => setHidden(uid, $hiddenQ, { artifactId: a.id }, !isHidden, a.name)}
      >
        {#if isHidden}<EyeOff size={16} aria-hidden="true" />{:else}<Eye
            size={16}
            aria-hidden="true"
          />{/if}
      </button>
    {:else}
      <span class="w-11"></span>
    {/if}
  </li>
{/snippet}

<div class="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8">
  <header class="flex items-center justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">Artifacts</h1>
      <p class="mt-1 text-sm text-muted">
        Small websites that live here — dashboards, trackers, forms — shared with exactly the people
        you choose.
      </p>
    </div>
    <Button variant="primary" icon={Plus} onclick={() => (creating = true)}>New artifact</Button>
  </header>

  <section aria-label="Your artifacts">
    {#if $q.loading}
      <div class="flex flex-col gap-2">
        {#each [1, 2, 3] as i (i)}<Skeleton height="3.25rem" class="rounded-xl" />{/each}
      </div>
    {:else if $q.error}
      <p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
        Couldn’t load your artifacts.
      </p>
    {:else if !groups.active.length}
      <EmptyState
        icon={AppWindow}
        title="No artifacts yet"
        description="Create one and publish a static build to it — or ask someone to share theirs with you."
      >
        {#snippet action()}<Button variant="primary" icon={Plus} onclick={() => (creating = true)}
            >New artifact</Button
          >{/snippet}
      </EmptyState>
    {:else}
      <div class="overflow-hidden rounded-xl border border-line bg-surface">
        <div
          class="hidden items-center gap-4 border-b border-line px-4 py-2 text-xs font-medium text-muted md:flex"
          aria-hidden="true"
        >
          <span class="w-6 shrink-0"></span>
          <span class="flex-1 basis-48">Name</span>
          <span class="w-44 shrink-0">Owner</span>
          <span class="w-16 shrink-0">Your role</span>
          <span class="w-28 shrink-0 text-right">Last updated</span>
        </div>
        <ul class="divide-y divide-line">
          {#each groups.active as a (a.id)}{@render row(a)}{/each}
        </ul>
      </div>
    {/if}
  </section>

  {#if groups.archived.length}
    <details class="group rounded-xl border border-line bg-surface">
      <summary
        class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted select-none"
      >
        <Archive size={16} aria-hidden="true" /> Archived artifacts
        <span class="text-subtle">({groups.archived.length})</span>
      </summary>
      <ul class="divide-y divide-line border-t border-line">
        {#each groups.archived as a (a.id)}{@render row(a)}{/each}
      </ul>
    </details>
  {/if}
</div>

<NewArtifactDialog bind:open={creating} />

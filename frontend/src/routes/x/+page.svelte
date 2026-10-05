<!--
  /x — All artifacts (docs/plan/artifacts.html §F): every artifact I have a
  role on as CARDS, drawn like the boards on the Boards page (layout/ItemTile)
  — who owns it, my role, when it last changed, and the eye that hides it from
  the sidebar. Archived ones in their own group, as the Boards page does.
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { AppWindow, Archive, Plus } from 'lucide-svelte';
  import type { ArtifactRole } from '@tm/shared';
  import { relativeTime } from '$lib/account/format';
  import NewArtifactDialog from '$lib/artifacts/NewArtifactDialog.svelte';
  import { artifactGlyph, myArtifacts, roleIn, splitArtifacts } from '$lib/artifacts/store';
  import { auth } from '$lib/firebase/auth.svelte';
  import ItemTile from '$lib/layout/ItemTile.svelte';
  import { routes } from '$lib/layout/routes';
  import { Principal } from '$lib/people';
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
      <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {#each [1, 2, 3] as i (i)}<Skeleton height="7rem" class="rounded-xl" />{/each}
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
      <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {#each groups.active as a (a.id)}
          {@const role = roleIn(a, uid)}
          <ItemTile
            dataKind="artifact"
            id={a.id}
            href={routes.artifact(a.id)}
            name={a.name}
            glyph={artifactGlyph(a)}
            description={a.description}
            badge={role ? ROLE_LABEL[role] : null}
            hidden={$hiddenQ.artifacts.has(a.id)}
            ontogglehidden={uid
              ? () =>
                  setHidden(
                    uid,
                    $hiddenQ,
                    { artifactId: a.id },
                    !$hiddenQ.artifacts.has(a.id),
                    a.name,
                  )
              : null}
            onopen={() => workspaceContext.leave()}
          >
            {#snippet meta()}
              <span class="flex min-w-0 items-center gap-1"
                >{#if a.ownerUid === uid}By you{:else}<Principal
                    id={a.ownerUid}
                    layout="inline"
                  />{/if}</span
              >
              <span
                >{#if !a.currentBuild}not published{:else}{relativeTime(a.updatedAt)}{/if}</span
              >
            {/snippet}
          </ItemTile>
        {/each}
        <button
          type="button"
          onclick={() => (creating = true)}
          class="flex min-h-28 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line-strong text-sm text-muted transition-colors hover:border-accent hover:text-accent"
        >
          <Plus size={18} aria-hidden="true" /> New artifact
        </button>
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
        {#each groups.archived as a (a.id)}
          <li class="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <span aria-hidden="true">{artifactGlyph(a)}</span>
            <a
              class="flex-1 truncate text-sm hover:underline"
              href={routes.artifact(a.id)}
              data-artifact={a.id}
              onclick={() => workspaceContext.leave()}>{a.name}</a
            >
            <span class="text-xs text-subtle">archived {relativeTime(a.archivedAt ?? 0)}</span>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</div>

<NewArtifactDialog bind:open={creating} />

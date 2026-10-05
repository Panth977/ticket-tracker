<!--
  /x/[artifactId]/settings/[section] — Artifact settings (docs/plan/artifacts.html §F):
    [menu: General · People · Builds · Data] | [the section]
  The same frame as board settings. Who sees what follows §B (artifactCan):
  the owner everything; an editor Builds and Data; a viewer has no settings at
  all and is sent back to the artifact. Hiding is manners — every command
  behind these screens checks the role itself.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowLeft } from 'lucide-svelte';
  import { artifactCan } from '@tm/shared';
  import { provideArtifactSettings } from '$lib/artifacts/settings/context.svelte';
  import { artifactDoc, roleIn, settingsSectionsFor } from '$lib/artifacts/store';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { workspaceContext } from '$lib/workspaces/context.svelte';
  import { switcherFor } from '$lib/workspaces/switcherStore';
  import TitleSwitcher from '$lib/workspaces/TitleSwitcher.svelte';
  import Indicator from '$lib/ui/Indicator.svelte';
  import WorkspaceCrumb from '$lib/workspaces/WorkspaceCrumb.svelte';

  let { children }: { children: Snippet } = $props();

  const artifactId = $derived(page.params.artifactId ?? '');
  const section = $derived(page.params.section ?? '');
  const docQ = $derived(artifactDoc(artifactId));
  const art = $derived($docQ.data);
  const me = $derived(auth.uid ?? '');
  const role = $derived(roleIn(art, me));
  const sections = $derived(settingsSectionsFor(role));
  // The same title dropdown as on the artifact itself (agents.html §AB3).
  const switchQ = $derived(switcherFor(me, { artifactId }, workspaceContext.id));

  // A viewer who typed the URL: there is nothing here for them.
  $effect(() => {
    if (art && role && !sections.length)
      void goto(routes.artifact(artifactId), { replaceState: true });
  });

  provideArtifactSettings({
    get artifact() {
      return art!;
    },
    get me() {
      return me;
    },
    get role() {
      return role!;
    },
    get isOwner() {
      return artifactCan.manage(role);
    },
    get canPublish() {
      return artifactCan.publish(role);
    },
  });
</script>

<svelte:head
  ><title>{art ? `Settings · ${art.name}` : 'Artifact settings'} — TaskManager</title></svelte:head
>

{#if $docQ.loading}
  <div class="flex flex-col gap-3 p-6">
    <Skeleton height="1.5rem" width="16rem" /><Skeleton lines={5} />
  </div>
{:else if !art || !role}
  <EmptyState
    title="Artifact not found"
    description="It may have been deleted, or it isn't shared with you."
  >
    {#snippet action()}<Button href={routes.artifacts()}>Your artifacts</Button>{/snippet}
  </EmptyState>
{:else if sections.length}
  <header class="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
    {#if $switchQ.workspace}<WorkspaceCrumb workspace={$switchQ.workspace} />{/if}
    <TitleSwitcher
      kind="artifact"
      items={$switchQ.items}
      name={art.name}
      mark={{ of: art, seed: artifactId }}
    />
    <span class="shrink-0 text-sm text-subtle">› Settings</span>
  </header>
  <div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:flex-row md:px-8">
    <nav class="flex shrink-0 flex-col gap-1 md:w-52" aria-label="Artifact settings">
      <a
        href={routes.artifact(artifactId)}
        class="mb-2 flex min-w-0 items-center gap-1.5 text-sm text-muted hover:text-text"
      >
        <ArrowLeft size={14} class="shrink-0" />
        <Indicator of={art} seed={artifactId} size="sm" />
        <span class="truncate">{art.name}</span>
      </a>
      <h1 class="mb-1 px-2 text-xs font-semibold tracking-wide text-subtle uppercase">Settings</h1>
      <ul class="flex gap-1 overflow-x-auto md:flex-col">
        {#each sections as s (s.id)}
          <li>
            <a
              href={routes.artifactSettings(artifactId, s.id)}
              aria-current={section === s.id ? 'page' : undefined}
              class="block rounded-md px-2 py-1.5 text-sm whitespace-nowrap {section === s.id
                ? 'bg-surface-2 font-medium text-text'
                : 'text-muted hover:bg-surface-2 hover:text-text'}"
            >
              {s.label}
            </a>
          </li>
        {/each}
      </ul>
    </nav>
    <div class="min-w-0 flex-1">
      {#if art.archivedAt != null}
        <p role="status" class="mb-4 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          This artifact is archived — its data is read-only and nothing can be published until it is
          restored{artifactCan.manage(role) ? ' (General)' : ''}.
        </p>
      {/if}
      {@render children()}
    </div>
  </div>
{/if}

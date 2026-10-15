<!--
  /bucket/[bucketId]/settings/[section] — Bucket settings (docs/plan/bucket.html §F),
  the same frame as artifact settings: the title dropdown on top, then
  [menu: General · People · Subscribers] | [the section].
  The owner sees all three; an editor or viewer only Subscribers.
-->
<script lang="ts">
  import { APP_NAME } from '$lib/brand';
  // hrefs are built by lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { ArrowLeft } from 'lucide-svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { provideBucketSettings } from '$lib/bucket/settings/context.svelte';
  import { bucketDoc, bucketRoleIn, bucketSettingsFor } from '$lib/bucket/store';
  import { Button, EmptyState, Skeleton } from '$lib/ui';
  import { switcherFor } from '$lib/orgs/switcherStore';
  import TitleSwitcher from '$lib/orgs/TitleSwitcher.svelte';
  import Indicator from '$lib/ui/Indicator.svelte';
  import { BUCKET_DEFAULT_INDICATOR } from '@tm/shared';
  import OrgCrumb from '$lib/orgs/OrgCrumb.svelte';

  let { children }: { children: Snippet } = $props();

  const bucketId = $derived(page.params.bucketId ?? '');
  const section = $derived(page.params.section ?? '');
  const docQ = $derived(bucketDoc(bucketId));
  const m = $derived($docQ.data);
  const me = $derived(auth.uid ?? '');
  const role = $derived(bucketRoleIn(m, me));
  const sections = $derived(bucketSettingsFor(role));
  const switchQ = $derived(switcherFor(me, { bucketId }));

  provideBucketSettings({
    get bucket() {
      return m!;
    },
    get me() {
      return me;
    },
    get role() {
      return role!;
    },
    get isOwner() {
      return role === 'owner';
    },
  });
</script>

<svelte:head
  ><title>{m ? `Settings · ${m.name}` : 'Bucket settings'} — {APP_NAME}</title></svelte:head
>

{#if $docQ.loading}
  <div class="flex flex-col gap-3 p-6">
    <Skeleton height="1.5rem" width="16rem" /><Skeleton lines={5} />
  </div>
{:else if !m || !role}
  <EmptyState
    title="Bucket not found"
    description="It may have been deleted, or it isn't shared with you."
  >
    {#snippet action()}<Button href={routes.buckets()}>All bucket</Button>{/snippet}
  </EmptyState>
{:else}
  <header class="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
    {#if $switchQ.org}<OrgCrumb org={$switchQ.org} />{/if}
    <TitleSwitcher
      kind="bucket"
      items={$switchQ.items}
      name={m.name}
      mark={{ of: m, seed: bucketId, fallback: BUCKET_DEFAULT_INDICATOR }}
    />
    <span class="shrink-0 text-sm text-subtle">› Settings</span>
  </header>
  <div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:flex-row md:px-8">
    <nav class="flex shrink-0 flex-col gap-1 md:w-52" aria-label="Bucket settings">
      <a
        href={routes.bucket(bucketId)}
        class="mb-2 flex min-w-0 items-center gap-1.5 text-sm text-muted hover:text-text"
      >
        <ArrowLeft size={14} class="shrink-0" />
        <Indicator of={m} seed={bucketId} fallback={BUCKET_DEFAULT_INDICATOR} size="sm" />
        <span class="truncate">{m.name}</span>
      </a>
      <h1 class="mb-1 px-2 text-xs font-semibold tracking-wide text-subtle uppercase">Settings</h1>
      <ul class="flex gap-1 overflow-x-auto md:flex-col">
        {#each sections as s (s.id)}
          <li>
            <a
              href={routes.bucketSettings(bucketId, s.id)}
              aria-current={section === s.id ? 'page' : undefined}
              class="block rounded-md px-2 py-1.5 text-sm whitespace-nowrap {section === s.id
                ? 'bg-surface-2 font-medium text-text'
                : 'text-muted hover:bg-surface-2 hover:text-text'}">{s.label}</a
            >
          </li>
        {/each}
      </ul>
    </nav>
    <div class="min-w-0 flex-1">
      {#if m.archivedAt != null}
        <p role="status" class="mb-4 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          This bucket is archived — its files are read-only until it is restored{role === 'owner'
            ? ' (General)'
            : ''}.
        </p>
      {/if}
      {@render children()}
    </div>
  </div>
{/if}

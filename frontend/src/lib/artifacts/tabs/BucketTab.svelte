<!--
  The host page's Bucket tab: every bucket granted to this artifact (bucket.html
  §H — what its BackendDriver.bucket reaches) that the VIEWER reaches too
  (bucketList({ artifactId })), opened in the bucket's own browser. ?bucket=
  picks one (the first when absent), and the browser's ?path= stays on this
  page, so a file in an artifact's bucket is linkable here.

  What you may do inside is what you may do on the bucket's own page: your
  reach, not the artifact's grant.
-->
<script lang="ts">
  // goto() targets are built from this page's own URL (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Brain, TriangleAlert } from 'lucide-svelte';
  import { artifactCan, BUCKET_DEFAULT_INDICATOR, type BucketOut } from '@tm/shared';
  import { command } from '$lib/api';
  import BucketBrowser from '$lib/bucket/BucketBrowser.svelte';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import Select from '$lib/ui/Select.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { withParams, type ArtifactTabProps } from './index';

  let { artifactId, role }: ArtifactTabProps = $props();

  let buckets = $state.raw<BucketOut[] | null>(null);
  let failed = $state(false);
  $effect(() => {
    const id = artifactId;
    buckets = null;
    failed = false;
    command('bucketList', { artifactId: id }, { toast: false }).then(
      (r) => id === artifactId && (buckets = r.buckets),
      () => id === artifactId && (failed = true),
    );
  });

  const wanted = $derived(page.url.searchParams.get('bucket'));
  const current = $derived(buckets?.find((b) => b.id === wanted) ?? buckets?.[0] ?? null);
  const options = $derived(
    (buckets ?? []).map((b) => ({
      value: b.id,
      label: b.name,
      indicator: { of: b, seed: b.id, fallback: BUCKET_DEFAULT_INDICATOR },
    })),
  );

  function pick(id: string | null) {
    if (!id || id === current?.id) return;
    void goto(withParams(page.url, { bucket: id, path: null, mode: null }), {
      keepFocus: true,
      noScroll: true,
    });
  }
  /** The browser's ?path=, on this page, for the bucket on screen. */
  const link = (bucketId: string) => (path: string | null) =>
    withParams(page.url, { bucket: bucketId, path });
</script>

<div class="flex min-h-0 flex-1 flex-col" data-artifact-tab="bucket">
  {#if failed}
    <EmptyState
      icon={TriangleAlert}
      title="Couldn't load the buckets"
      description="Something went wrong. Check your connection and try again."
    />
  {:else if !buckets}
    <div class="flex flex-col gap-3 p-6"><Skeleton lines={4} /></div>
  {:else if !current}
    <EmptyState
      icon={Brain}
      title="No buckets to show"
      description={artifactCan.manage(role)
        ? 'This artifact has not been given a bucket yet. Grant one in its settings › Subscriptions; its page then reaches it through BackendDriver.bucket.'
        : 'This artifact uses no bucket you can open.'}
    >
      {#snippet action()}
        {#if artifactCan.manage(role)}
          <Button href={routes.artifactSettings(artifactId, 'subscriptions')}>Subscriptions</Button>
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    {#if buckets.length > 1}
      <div class="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
        <span class="text-xs text-muted">Bucket</span>
        <Select
          {options}
          value={current.id}
          aria-label="Bucket"
          class="w-64 max-w-full"
          onchange={(e) => pick(e.currentTarget.value)}
        />
      </div>
    {/if}
    <!-- The browser sizes itself to what is left of the window under it. -->
    {#key current.id}
      <BucketBrowser bucketId={current.id} link={link(current.id)} />
    {/key}
  {/if}
</div>

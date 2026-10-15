<!--
  /m — All bucket (docs/plan/bucket.html §F): every bucket I have a role on,
  as CARDS drawn like the boards on the Boards page (layout/ItemTile): my
  role, how many files and how much, when it last changed, and the eye that
  hides it from the sidebar. Archived ones in their own group.
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { Archive, Brain, Plus } from 'lucide-svelte';
  import { BUCKET_DEFAULT_INDICATOR, formatBytes, type BucketRole } from '@tm/shared';
  import { relativeTime } from '$lib/account/format';
  import { auth } from '$lib/firebase/auth.svelte';
  import ItemTile from '$lib/layout/ItemTile.svelte';
  import Indicator from '$lib/ui/Indicator.svelte';
  import { routes } from '$lib/layout/routes';
  import NewBucketDialog from '$lib/bucket/NewBucketDialog.svelte';
  import { bucketRoleIn, myBuckets, splitBuckets } from '$lib/bucket/store';
  import { Button, EmptyState, Skeleton } from '$lib/ui';
  import { hiddenItems, setHidden } from '$lib/layout/hidden';

  const uid = $derived(auth.uid);
  const q = $derived(myBuckets(uid));
  const groups = $derived(splitBuckets($q.data));
  const hiddenQ = $derived(hiddenItems(uid));
  let creating = $state(false);

  const ROLE_LABEL: Record<BucketRole, string> = {
    owner: 'Owner',
    editor: 'Editor',
    viewer: 'Viewer',
  };
</script>

<svelte:head><title>Bucket · TaskManager</title></svelte:head>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8">
  <header class="flex items-center justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">Bucket</h1>
      <p class="mt-1 text-sm text-muted">
        Buckets of files you keep online — notes, screenshots, videos, builds. Tickets and artifacts
        use them without a second upload.
      </p>
    </div>
    <Button variant="primary" icon={Plus} onclick={() => (creating = true)}>New bucket</Button>
  </header>

  <section aria-label="Your bucket">
    {#if $q.loading}
      <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {#each [1, 2, 3] as i (i)}<Skeleton height="7rem" class="rounded-xl" />{/each}
      </div>
    {:else if $q.error}
      <p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
        Couldn’t load your bucket.
      </p>
    {:else if !groups.active.length}
      <EmptyState
        icon={Brain}
        title="No bucket yet"
        description="Create one, then drop files and folders into it — or ask someone to share theirs with you."
      >
        {#snippet action()}<Button variant="primary" icon={Plus} onclick={() => (creating = true)}
            >New bucket</Button
          >{/snippet}
      </EmptyState>
    {:else}
      <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {#each groups.active as m (m.id)}
          {@const role = bucketRoleIn(m, uid)}
          <ItemTile
            dataKind="bucket"
            id={m.id}
            href={routes.bucket(m.id)}
            name={m.name}
            of={m}
            fallback={BUCKET_DEFAULT_INDICATOR}
            description={m.description}
            badge={role ? ROLE_LABEL[role] : null}
            hidden={$hiddenQ.buckets.has(m.id)}
            ontogglehidden={uid
              ? () =>
                  setHidden(uid, $hiddenQ, { bucketId: m.id }, !$hiddenQ.buckets.has(m.id), m.name)
              : null}
          >
            {#snippet meta()}
              <span>{m.stats.files} {m.stats.files === 1 ? 'file' : 'files'}</span>
              <span>{formatBytes(m.stats.bytes)}</span>
              <span>{relativeTime(m.updatedAt)}</span>
            {/snippet}
          </ItemTile>
        {/each}
        <button
          type="button"
          onclick={() => (creating = true)}
          class="flex min-h-28 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line-strong text-sm text-muted transition-colors hover:border-accent hover:text-accent"
        >
          <Plus size={18} aria-hidden="true" /> New bucket
        </button>
      </div>
    {/if}
  </section>

  {#if groups.archived.length}
    <details class="group rounded-xl border border-line bg-surface">
      <summary
        class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted select-none"
      >
        <Archive size={16} aria-hidden="true" /> Archived bucket
        <span class="text-subtle">({groups.archived.length})</span>
      </summary>
      <ul class="divide-y divide-line border-t border-line">
        {#each groups.archived as m (m.id)}
          <li class="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <Indicator of={m} seed={m.id} fallback={BUCKET_DEFAULT_INDICATOR} size="sm" />
            <a
              class="flex-1 truncate text-sm hover:underline"
              href={routes.bucket(m.id)}
              data-bucket={m.id}>{m.name}</a
            >
            <span class="text-xs text-subtle">archived {relativeTime(m.archivedAt ?? 0)}</span>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</div>

<NewBucketDialog bind:open={creating} />

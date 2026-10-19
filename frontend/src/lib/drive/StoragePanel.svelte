<!--
  A board's or an artifact's Storage tab (bucket.html §K6): the buckets it
  keeps files in, where each lives, and — for a bucket I own — moving it.
  None yet: make one here (managed or Drive), as the create pages do.
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { BucketOut } from '@tm/shared';
  import { command } from '$lib/api';
  import { routes } from '$lib/layout/routes';
  import { Button, Skeleton, toast } from '$lib/ui';
  import StorageField, { type StorageChoice } from './StorageField.svelte';
  import StorageMove from './StorageMove.svelte';
  import { driveState } from './drive.svelte';
  import { storageFor } from './storageFor';

  let {
    target,
    name,
    /** The board's attachment bucket (§J), listed first and called so. */
    attachBucketId = null,
    /** May this person add a bucket here (board admin / artifact owner)? */
    manages = false,
  }: {
    target: { boardId: string } | { artifactId: string };
    name: string;
    attachBucketId?: string | null;
    manages?: boolean;
  } = $props();

  let buckets = $state<BucketOut[] | null>(null);
  async function load() {
    try {
      const r = await command('bucketList', { ...target }, { toast: false });
      buckets = [...r.buckets].sort(
        (a, b) => Number(b.id === attachBucketId) - Number(a.id === attachBucketId),
      );
    } catch {
      buckets = [];
    }
  }
  $effect(() => {
    void target;
    void load();
  });

  let choice = $state<StorageChoice>({ kind: 'managed' });
  let busy = $state(false);
  const ready = $derived(choice.kind !== 'drive' || !!driveState.status?.connected);
  async function create() {
    busy = true;
    try {
      await storageFor(choice, target, {
        name: 'boardId' in target ? `${name} ticket files` : `${name} files`,
      });
      toast.success('Bucket created');
      await load();
    } catch (e) {
      toast.error('Could not create the bucket', (e as Error).message);
    } finally {
      busy = false;
    }
  }
</script>

{#if buckets === null}
  <Skeleton height="4rem" lines={2} />
{:else if !buckets.length}
  <div class="flex flex-col gap-4">
    <p class="text-sm text-muted">
      {'boardId' in target
        ? 'This board has no bucket for its ticket files yet.'
        : 'This artifact uses no bucket yet.'}
    </p>
    {#if manages}
      <StorageField
        bind:value={choice}
        name={'boardId' in target ? `${name} ticket files` : `${name} files`}
        label="Make one, stored in"
        managedHint="A new bucket, kept by this app"
      />
      <div>
        <Button variant="primary" loading={busy} disabled={!ready} onclick={create}
          >Create the bucket</Button
        >
      </div>
    {/if}
  </div>
{:else}
  <ul class="flex flex-col gap-6">
    {#each buckets as bk (bk.id)}
      <li class="flex flex-col gap-2">
        <div class="flex items-center gap-2 text-sm">
          <a class="font-medium hover:underline" href={routes.bucket(bk.id)}>{bk.name}</a>
          {#if bk.id === attachBucketId}<span class="rounded bg-surface-2 px-1.5 text-xs text-muted"
              >ticket files go here</span
            >{/if}
        </div>
        {#if bk.reach === 'manage'}
          <StorageMove bucketId={bk.id} name={bk.name} />
        {:else}
          <p class="text-sm text-muted">
            {bk.storage?.kind === 'drive'
              ? `In Google Drive (${bk.storage.folderName ?? 'a folder'}${bk.storage.email ? `, ${bk.storage.email}` : ''}).`
              : 'Managed by this app.'} Only its owner can move it.
          </p>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

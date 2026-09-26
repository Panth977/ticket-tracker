<!--
  The outbox at the bottom of the sidebar (agents.html § K › The outbox):
    'Syncing · 2'   while anything is on its way (offline: 'Waiting for connection · 2')
    '⚠ 1 failed'    when something failed — click for the list, each with Open · Retry · Cancel
  Nothing at all when the outbox is empty.
-->
<script lang="ts">
  import { CloudOff, RotateCw, TriangleAlert } from 'lucide-svelte';
  import { outbox, type OutboxEntry } from '$lib/api';
  import { online } from '$lib/stores';
  import Popover from '$lib/ui/Popover.svelte';

  const pending = $derived(outbox.pending);
  const failed = $derived(outbox.failed);
  let open = $state(false);
  let anchor: HTMLButtonElement | null = $state(null);

  $effect(() => {
    if (!failed.length && !pending.length) open = false;
  });

  function when(e: OutboxEntry): string {
    return new Date(e.createdAt).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  }
</script>

{#if failed.length || pending.length}
  <button
    bind:this={anchor}
    type="button"
    onclick={() => (open = !open)}
    aria-expanded={open}
    aria-live="polite"
    class="tm-press tm-fade-in flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-medium
      {failed.length
      ? 'bg-danger-soft text-danger hover:brightness-95'
      : 'text-muted hover:bg-surface-2'}"
  >
    {#if failed.length}
      <TriangleAlert size={14} aria-hidden="true" />
      <span class="flex-1">{failed.length} failed</span>
      {#if pending.length}<span class="font-normal opacity-80">· syncing {pending.length}</span
        >{/if}
    {:else if !$online}
      <CloudOff size={14} aria-hidden="true" />
      <span class="flex-1">Waiting for connection · {pending.length}</span>
    {:else}
      <span
        class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
        aria-hidden="true"
      ></span>
      <span class="flex-1">Syncing · {pending.length}</span>
    {/if}
  </button>

  <Popover
    bind:open
    {anchor}
    placement="top-start"
    label="Changes waiting to sync"
    class="tm-pop w-80 max-w-[calc(100vw-2rem)] p-1"
  >
    <ul class="flex max-h-80 flex-col overflow-y-auto">
      {#each failed as e (e.id)}
        <li class="flex flex-col gap-1 rounded-md px-2.5 py-2 hover:bg-surface-2">
          <p class="text-sm"><span class="font-medium text-danger">Couldn't</span> {e.label}</p>
          {#if e.error}<p class="text-xs text-muted">{e.error}</p>{/if}
          <div class="flex items-center gap-3 text-xs font-medium">
            {#if e.openTo}<button
                type="button"
                class="text-accent hover:underline"
                onclick={() => {
                  open = false;
                  outbox.open(e.id);
                }}>Open</button
              >{/if}
            <button
              type="button"
              class="text-accent hover:underline"
              onclick={() => outbox.retry(e.id)}>Retry</button
            >
            <button
              type="button"
              class="text-muted hover:underline"
              onclick={() => outbox.cancel(e.id)}>Cancel</button
            >
            <span class="ml-auto font-normal text-subtle">{when(e)}</span>
          </div>
        </li>
      {/each}
      {#each pending as e (e.id)}
        <li class="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted">
          {#if e.status === 'retrying'}<RotateCw size={13} class="shrink-0" aria-label="Retrying" />
          {:else if e.status === 'offline'}<CloudOff
              size={13}
              class="shrink-0"
              aria-label="Waiting for connection"
            />
          {:else}<span
              class="size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-label="Sending"
            ></span>{/if}
          <span class="min-w-0 flex-1 truncate"
            >{e.label.charAt(0).toUpperCase() + e.label.slice(1)}</span
          >
          <span class="text-xs text-subtle">{when(e)}</span>
        </li>
      {/each}
    </ul>
  </Popover>
{/if}

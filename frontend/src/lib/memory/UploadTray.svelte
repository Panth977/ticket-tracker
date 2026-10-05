<!--
  Uploads in flight (memory.html §F): bottom-right, one row per file with its
  progress; finished rows stay until dismissed so a failure is not missed.
-->
<script lang="ts">
  import { Check, Loader2, TriangleAlert, X } from 'lucide-svelte';
  import { formatBytes } from '@tm/shared';
  import { memoryUploads } from './upload.svelte';

  let { memoryId }: { memoryId: string } = $props();
  const items = $derived(memoryUploads.items.filter((i) => i.memoryId === memoryId));
</script>

{#if items.length}
  <section
    class="fixed right-4 bottom-4 z-30 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
    aria-label="Uploads"
    data-upload-tray
  >
    <header class="flex items-center gap-2 border-b border-line px-3 py-2 text-sm font-medium">
      <span class="flex-1"
        >{memoryUploads.active ? `Uploading ${memoryUploads.active}…` : 'Uploads'}</span
      >
      <button
        type="button"
        class="grid size-6 place-items-center rounded text-subtle hover:bg-surface-2 hover:text-text"
        aria-label="Clear finished uploads"
        onclick={() => memoryUploads.clear()}><X size={14} /></button
      >
    </header>
    <ul class="max-h-64 divide-y divide-line overflow-y-auto">
      {#each items as u (u.key)}
        <li
          class="flex items-center gap-2 px-3 py-2 text-xs"
          data-upload={u.path}
          data-status={u.status}
        >
          <span class="grid size-5 shrink-0 place-items-center">
            {#if u.status === 'done'}<Check size={14} class="text-success" />
            {:else if u.status === 'error'}<TriangleAlert size={14} class="text-danger" />
            {:else}<Loader2 size={14} class="animate-spin text-muted" />{/if}
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate" title={u.path}>{u.path}</span>
            {#if u.status === 'error'}<span class="block text-danger">{u.error}</span>
            {:else if u.status === 'uploading' || u.status === 'queued'}
              <span class="mt-1 block h-1 overflow-hidden rounded bg-surface-3"
                ><span class="block h-full bg-accent" style:width="{Math.round(u.progress * 100)}%"
                ></span></span
              >
            {:else}<span class="block text-subtle"
                >{formatBytes(u.size)}{u.status === 'saving' ? ' · saving…' : ''}</span
              >{/if}
          </span>
          {#if u.status === 'queued'}
            <button
              type="button"
              class="text-subtle hover:text-text"
              aria-label="Cancel {u.name}"
              onclick={() => memoryUploads.cancel(u.key)}><X size={13} /></button
            >
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

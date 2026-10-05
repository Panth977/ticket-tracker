<!--
  A value as a collapsible tree (the Data section's RTDB browser and document
  viewer). Branches below the first level start closed and are only RENDERED
  when opened, so a large subtree costs nothing until someone looks at it.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { ChevronRight } from 'lucide-svelte';
  import JsonTree from './JsonTree.svelte';

  interface Props {
    value: unknown;
    /** The key this value sits under (absent at the root). */
    name?: string;
    depth?: number;
  }
  let { value, name, depth = 0 }: Props = $props();

  const isBranch = (v: unknown): v is Record<string, unknown> | unknown[] =>
    !!v && typeof v === 'object' && !(v instanceof Date);
  const entries = $derived(
    isBranch(value)
      ? Array.isArray(value)
        ? value.map((v, i) => [String(i), v] as const)
        : Object.entries(value)
      : [],
  );
  // The starting state only: after that the person decides.
  let open = $state(untrack(() => depth < 1));
  /** Long lists are shown a page at a time — a 10,000-key node must not freeze the tab. */
  let shown = $state(100);

  const leaf = (v: unknown): string =>
    v instanceof Date ? v.toISOString() : typeof v === 'string' ? JSON.stringify(v) : String(v);
  const tone = (v: unknown): string =>
    v === null
      ? 'text-subtle'
      : typeof v === 'string'
        ? 'text-success'
        : v instanceof Date
          ? 'text-warning'
          : 'text-accent';
</script>

{#if isBranch(value)}
  <div class="font-mono text-xs leading-5">
    <button
      type="button"
      class="flex items-center gap-1 rounded text-left hover:bg-surface-2"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      <ChevronRight
        size={12}
        class="shrink-0 transition-transform {open ? 'rotate-90' : ''}"
        aria-hidden="true"
      />
      {#if name !== undefined}<span class="text-text">{name}</span>{/if}
      <span class="text-subtle"
        >{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span
      >
    </button>
    {#if open}
      <div class="ml-1.5 border-l border-line pl-3">
        {#each entries.slice(0, shown) as [k, v] (k)}
          <JsonTree value={v} name={k} depth={depth + 1} />
        {/each}
        {#if entries.length > shown}
          <button type="button" class="text-accent hover:underline" onclick={() => (shown += 200)}
            >Show more ({entries.length - shown} left)</button
          >
        {/if}
      </div>
    {/if}
  </div>
{:else}
  <div class="flex gap-1.5 pl-4 font-mono text-xs leading-5">
    {#if name !== undefined}<span class="shrink-0 text-text">{name}:</span>{/if}
    <span class="min-w-0 break-all {tone(value)}">{leaf(value)}</span>
  </div>
{/if}

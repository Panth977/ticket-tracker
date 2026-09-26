<!--
  Long content collapses behind 'Show more' (agents.html §H: messages over
  about 40 lines). Measured, not counted, so rich text and Markdown behave the
  same: over `maxLines` × line-height it is clipped with a fade.
    <Collapsible maxLines={40}>…</Collapsible>
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    maxLines?: number;
    /** px per line (the thread's text-sm line-height ≈ 21.7px). */
    lineHeight?: number;
    children: Snippet;
  }
  let { maxLines = 40, lineHeight = 22, children }: Props = $props();

  let inner: HTMLElement | undefined = $state();
  let height = $state(0);
  let open = $state(false);
  const limit = $derived(maxLines * lineHeight);
  // A little slack, so content just over the line isn't clipped by a few px.
  const long = $derived(height > limit * 1.15);

  $effect(() => {
    if (!inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => (height = inner?.scrollHeight ?? 0));
    ro.observe(inner);
    height = inner.scrollHeight;
    return () => ro.disconnect();
  });
</script>

<div class="relative">
  <div
    bind:this={inner}
    class="overflow-hidden"
    style:max-height={long && !open ? `${limit}px` : undefined}
    data-collapsed={long && !open ? '' : undefined}
  >
    {@render children()}
  </div>
  {#if long && !open}
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-surface to-transparent"
      aria-hidden="true"
    ></div>
  {/if}
</div>
{#if long}
  <button
    type="button"
    class="mt-1 text-xs font-medium text-accent hover:underline"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    {open ? 'Show less' : 'Show more'}
  </button>
{/if}

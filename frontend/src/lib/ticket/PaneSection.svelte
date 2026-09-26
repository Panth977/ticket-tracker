<!--
  A collapsible section of the ticket's right pane (Details · Attachments ·
  Activity). Open / closed is remembered per browser per section.
    <PaneSection id="files" title="Attachments" count={3}>…</PaneSection>
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { slide } from 'svelte/transition';
  import { ChevronRight } from 'lucide-svelte';
  import { motion } from '$lib/ui/motion';

  interface Props {
    id: string;
    title: string;
    count?: number;
    /** Shown after the title (e.g. a 'New' dot). */
    badge?: Snippet;
    children: Snippet;
  }
  let { id, title, count, badge, children }: Props = $props();

  const KEY = 'tm.ticketPane.closed';
  function load(): string[] {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[];
    } catch {
      return [];
    }
  }
  // The section id is fixed for the component's life.
  // svelte-ignore state_referenced_locally
  let open = $state(!load().includes(id));
  function toggle() {
    open = !open;
    try {
      const rest = load().filter((x) => x !== id);
      localStorage.setItem(KEY, JSON.stringify(open ? rest : [...rest, id]));
    } catch {
      /* private mode */
    }
  }
</script>

<section class="border-b border-line last:border-b-0" aria-labelledby="pane-{id}">
  <h2 id="pane-{id}" class="sticky top-0 z-[2] bg-surface">
    <button
      type="button"
      onclick={toggle}
      aria-expanded={open}
      class="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-xs font-semibold tracking-wide text-muted uppercase hover:text-text"
    >
      <ChevronRight
        size={14}
        class="shrink-0 transition-transform duration-150 {open ? 'rotate-90' : ''}"
        aria-hidden="true"
      />
      <span>{title}</span>
      {#if count}<span class="font-normal text-subtle normal-case">{count}</span>{/if}
      {@render badge?.()}
    </button>
  </h2>
  {#if open}
    <div class="px-4 pb-4" transition:slide={{ duration: motion(160) }}>{@render children()}</div>
  {/if}
</section>

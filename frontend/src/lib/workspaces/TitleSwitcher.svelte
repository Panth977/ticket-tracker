<!--
  THE TITLE DROPDOWN (agents.html §AB3) — one control for a board, an
  artifact and a memory, so the three headers look and behave the same: the
  name as the page title, a ▾, and the switcher list (./switcher) on click.
  `kind` names the data attribute tests and the e2e suites find it by
  (data-board-switcher / data-artifact-switcher / data-memory-switcher).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ChevronDown } from 'lucide-svelte';
  import Menu from '$lib/ui/Menu.svelte';
  import Indicator from '$lib/ui/Indicator.svelte';
  import type { MenuItem } from '$lib/ui/types';

  interface Props {
    kind: 'board' | 'artifact' | 'memory';
    items: MenuItem[];
    name: string;
    /** Before the name, small and muted: a board's key. */
    prefix?: string | null;
    /** Before everything: the entity's indicator (indicators.html). */
    mark?: MenuItem['indicator'] | null;
    leading?: Snippet;
  }
  let { kind, items, name, prefix = null, mark = null, leading }: Props = $props();
  const title = $derived(`Switch ${kind}`);
</script>

<Menu {items} placement="bottom-start">
  {#snippet trigger(p)}
    <button
      type="button"
      {...p}
      {...{ [`data-${kind}-switcher`]: '' }}
      {title}
      class="tm-tap flex h-8 min-w-0 items-center gap-1.5 rounded-md px-1 hover:bg-surface-2"
    >
      {@render leading?.()}
      {#if mark}<Indicator
          indicator={mark.indicator}
          of={mark.of}
          seed={mark.seed}
          fallback={mark.fallback}
          size="md"
        />{/if}
      <h1 class="flex min-w-0 items-baseline gap-1.5 text-base font-semibold">
        {#if prefix}<span class="text-xs tracking-wide text-subtle">{prefix}</span>{/if}
        <span class="truncate">{name}</span>
      </h1>
      <ChevronDown size={14} class="shrink-0 text-subtle" aria-hidden="true" />
    </button>
  {/snippet}
</Menu>

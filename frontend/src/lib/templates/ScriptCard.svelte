<!--
  One board card drawn by the board script's previewTicketCard (docs/plan/board-script.html):
  a static tree (no handlers — the card itself opens the ticket). Until the tree is
  there, or when the script fails on this ticket, the built-in card (`fallback`)
  stands in, with a ⚠ saying why.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { TriangleAlert } from 'lucide-svelte';
  import { createRenderer, type Renderer } from './render';
  import { mountPerson } from './mountPerson';
  import type { CardTree } from './script';

  interface Props {
    card: CardTree | undefined;
    ticketHref?: (key: string) => string;
    fallback: Snippet;
  }
  let { card, ticketHref, fallback }: Props = $props();

  let root: HTMLDivElement | undefined = $state();
  let renderer = $state<Renderer | null>(null);
  $effect(() => {
    if (!root) return;
    const r = createRenderer(root, { person: mountPerson, ticketHref });
    renderer = r;
    return () => r.destroy();
  });
  $effect(() => {
    if (renderer && card?.tree) renderer.update(card.tree, 0);
  });
  const error = $derived(
    card?.error ? `Board script: ${card.error}${card.line ? ` (line ${card.line})` : ''}` : '',
  );
</script>

<div class="tm-template-card text-sm" class:hidden={!card?.tree} bind:this={root}></div>
{#if !card?.tree}
  <div class="relative">
    {#if error}
      <span class="absolute -top-1 right-0 text-warning" title={error} aria-label={error}
        ><TriangleAlert size={12} /></span
      >
    {/if}
    {@render fallback()}
  </div>
{/if}

<!--
  '+ Link' — the same # search the composer uses, in a popover.
  <TicketPicker label="Link a ticket" exclude={[…]} onpick={(hit) => …}>{#snippet trigger(p)}…{/snippet}</TicketPicker>
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Popover } from '$lib/ui';
  import { searchTickets, type TicketHit } from '$lib/editor';
  import { getTicketCtx } from './context';

  interface Props {
    label: string;
    exclude?: string[];
    onpick: (hit: TicketHit) => void;
    trigger: Snippet<
      [{ onclick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'dialog' }]
    >;
    /** Extra controls above the search (the link type). */
    header?: Snippet;
  }
  let { label, exclude = [], onpick, trigger, header }: Props = $props();

  const t = getTicketCtx();
  let open = $state(false);
  let anchorWrap = $state<HTMLSpanElement | null>(null);
  const anchor = $derived(anchorWrap?.querySelector<HTMLElement>('button,a') ?? anchorWrap);
  let q = $state('');
  let hits = $state<TicketHit[]>([]);
  let loading = $state(false);
  let index = $state(0);
  let seq = 0;

  $effect(() => {
    if (!open) return;
    const query = q;
    const mine = ++seq;
    loading = true;
    const timer = setTimeout(async () => {
      const r = await searchTickets(query, {
        boardId: t.boardId,
        exclude: [t.ticketId, ...exclude],
      });
      if (mine !== seq) return;
      hits = r;
      index = 0;
      loading = false;
    }, 150);
    return () => clearTimeout(timer);
  });
  $effect(() => {
    if (!open) q = '';
  });

  function choose(h: TicketHit) {
    open = false;
    onpick(h);
  }
  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (hits.length) index = (index + 1) % hits.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hits.length) index = (index - 1 + hits.length) % hits.length;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const h = hits[index];
      if (h) choose(h);
    }
  }
</script>

<span bind:this={anchorWrap} class="contents">
  {@render trigger({
    onclick: () => (open = !open),
    'aria-expanded': open,
    'aria-haspopup': 'dialog',
  })}
</span>

<Popover bind:open {anchor} {label} class="w-80 p-2">
  {#if header}<div class="mb-2">{@render header()}</div>{/if}
  <!-- svelte-ignore a11y_autofocus -->
  <input
    type="text"
    bind:value={q}
    {onkeydown}
    autofocus
    placeholder="Search by key or title…"
    aria-label="Search tickets"
    class="h-8 w-full rounded-md border border-line bg-surface px-2 text-sm focus:border-accent focus:outline-none"
  />
  <div role="listbox" aria-label="Tickets" class="mt-1 max-h-64 overflow-y-auto">
    {#if loading && !hits.length}
      <p class="px-2 py-1.5 text-sm text-muted">Searching…</p>
    {:else if !hits.length}
      <p class="px-2 py-1.5 text-sm text-muted">{q ? 'No matching tickets' : 'Type to search'}</p>
    {:else}
      {#each hits as h, i (h.ticketId)}
        <button
          type="button"
          role="option"
          aria-selected={i === index}
          onclick={() => choose(h)}
          onmouseenter={() => (index = i)}
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm {i === index
            ? 'bg-surface-2'
            : ''}"
        >
          <span class="shrink-0 font-mono text-xs text-muted">{h.key}</span>
          <span class="min-w-0 flex-1 truncate">{h.title}</span>
        </button>
      {/each}
    {/if}
  </div>
</Popover>

<!--
  The floating list for the editor's @ / # / slash pickers. Mounted into
  <body> by suggest.svelte.ts and driven by its shared $state (items, index,
  anchor rect); keyboard handling lives there, clicks here.
-->
<script lang="ts">
  import Avatar from '$lib/ui/Avatar.svelte';
  import type { SuggestItem, SuggestState } from './suggest.svelte';

  interface Props {
    state: SuggestState;
    onpick: (item: SuggestItem) => void;
  }
  let { state: s, onpick }: Props = $props();

  let el: HTMLDivElement | undefined = $state();
  let height = $state(0);

  const pos = $derived.by(() => {
    const r = s.rect;
    if (!r) return 'display:none';
    const vw = typeof window === 'undefined' ? 1024 : window.innerWidth;
    const vh = typeof window === 'undefined' ? 768 : window.innerHeight;
    const width = Math.min(320, vw - 16);
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    // Composer sits at the bottom of the screen: open upwards when there is no room below.
    const below = r.bottom + 6 + height <= vh - 8 || r.top < height + 12;
    const top = below ? r.bottom + 6 : r.top - 6 - height;
    return `left:${left}px;top:${Math.max(8, top)}px;width:${width}px`;
  });

  $effect(() => {
    void s.index;
    el?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  });
</script>

<div
  bind:this={el}
  bind:clientHeight={height}
  role="listbox"
  aria-label={s.label}
  tabindex="-1"
  style={pos}
  class="fixed z-[70] max-h-64 overflow-y-auto rounded-lg border border-line bg-surface py-1 text-text shadow-pop"
  onmousedown={(e) => e.preventDefault()}
>
  {#if s.loading && !s.items.length}
    <div class="px-3 py-2 text-sm text-muted">Searching…</div>
  {:else if !s.items.length}
    <div class="px-3 py-2 text-sm text-muted">{s.empty}</div>
  {:else}
    {#each s.items as item, i (item.id)}
      <button
        type="button"
        role="option"
        aria-selected={i === s.index}
        onclick={() => onpick(item)}
        onmouseenter={() => (s.index = i)}
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm {i === s.index
          ? 'bg-surface-2'
          : ''}"
      >
        {#if item.kind === 'person'}
          <Avatar
            src={item.avatarUrl}
            icon={item.icon}
            name={item.label}
            seed={item.uid}
            size={22}
            decorative
          />
          <span class="flex min-w-0 flex-col leading-tight">
            <span class="truncate">{item.label}</span>
            {#if item.detail}<span class="truncate text-xs text-muted">{item.detail}</span>{/if}
          </span>
        {:else if item.kind === 'ticket'}
          <span class="shrink-0 font-mono text-xs text-muted">{item.key}</span>
          <span class="min-w-0 flex-1 truncate">{item.label}</span>
          {#if item.detail}<span class="shrink-0 text-xs text-subtle">{item.detail}</span>{/if}
        {:else}
          <span class="shrink-0 font-mono text-sm">{item.label}</span>
          {#if item.detail}<span class="min-w-0 truncate text-xs text-muted">{item.detail}</span
            >{/if}
        {/if}
      </button>
    {/each}
  {/if}
</div>

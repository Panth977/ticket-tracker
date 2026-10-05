<!--
  One picker for every "choose from a list" value on the board: stages,
  priorities, tags, select options, people (items with `uid` render as
  PersonChips). Single or multi; a search box appears for long lists.

  <ChoicePicker items={…} selected={['a']} multi onchange={(ids) => …} />
-->
<script lang="ts" module>
  import type { Indicator as IndicatorT } from '@tm/shared';
  export interface ChoiceItem {
    id: string;
    label: string;
    color?: string;
    /** indicators.html: drawn instead of the colour dot (stages). */
    indicator?: IndicatorT;
    /** A tooltip on the row (a stage's description). */
    hint?: string | null;
    /** A person: drawn with PersonChip. */
    uid?: string;
    /** Extra text matched by the search box (e.g. email). */
    search?: string;
  }
</script>

<script lang="ts">
  import { Check, ChevronDown } from 'lucide-svelte';
  import type { Snippet } from 'svelte';
  import Popover from '$lib/ui/Popover.svelte';
  import PersonChip from '$lib/ui/PersonChip.svelte';
  import Indicator from '$lib/ui/Indicator.svelte';

  interface Props {
    items: ChoiceItem[];
    selected: string[];
    multi?: boolean;
    /** Text on the trigger when nothing is chosen. */
    placeholder?: string;
    /** Offer 'None' (single mode) — clears the value. */
    allowNone?: boolean;
    disabled?: boolean;
    label?: string;
    onchange: (ids: string[]) => void;
    /** Replace the default trigger content. */
    display?: Snippet<[ChoiceItem[]]>;
    class?: string;
    /** Open immediately (inline cell editors). */
    autoOpen?: boolean;
    onclose?: () => void;
    /**
     * Phase 8 (§P2): a card's assignee cluster is the trigger itself — avatars
     * and a '+', nothing else — so it turns the chevron (and the button's own
     * frame, via `class`) off.
     */
    chevron?: boolean;
  }
  let {
    items,
    selected,
    multi = false,
    placeholder = 'Choose…',
    allowNone = false,
    disabled = false,
    label,
    onchange,
    display,
    class: cls = '',
    autoOpen = false,
    onclose,
    chevron = true,
  }: Props = $props();

  let open = $state(false);
  let anchor: HTMLButtonElement | null = $state(null);
  let query = $state('');
  let searchEl: HTMLInputElement | null = $state(null);

  $effect(() => {
    if (autoOpen && anchor) open = true;
  });
  $effect(() => {
    if (open) queueMicrotask(() => searchEl?.focus());
  });

  const chosen = $derived(items.filter((i) => selected.includes(i.id)));
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => `${i.label} ${i.search ?? ''}`.toLowerCase().includes(q));
  });

  function toggle(id: string) {
    if (multi) {
      onchange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    } else {
      onchange([id]);
      close();
    }
  }
  function close() {
    open = false;
    query = '';
    onclose?.();
  }
</script>

<button
  bind:this={anchor}
  type="button"
  {disabled}
  aria-label={label}
  aria-haspopup="listbox"
  aria-expanded={open}
  class="inline-flex h-7 max-w-full min-w-0 items-center gap-1 rounded-md border border-line bg-surface px-2 text-left text-xs hover:bg-surface-2 disabled:opacity-50 {cls}"
  onclick={() => (open ? close() : (open = true))}
>
  <span class="flex min-w-0 flex-1 items-center gap-1 truncate">
    {#if display}
      {@render display(chosen)}
    {:else if chosen.length === 0}
      <span class="text-muted">{placeholder}</span>
    {:else if chosen.length > 2}
      <span>{chosen.length} selected</span>
    {:else}
      {#each chosen as c (c.id)}
        {#if c.uid}
          <PersonChip uid={c.uid} layout="compact" size={16} />
        {:else}
          <span class="inline-flex items-center gap-1 truncate">
            {#if c.indicator}<Indicator indicator={c.indicator} size="xs" />{:else if c.color}<span
                class="size-2 shrink-0 rounded-full"
                style="background:{c.color}"
              ></span>{/if}{c.label}
          </span>
        {/if}
      {/each}
    {/if}
  </span>
  {#if chevron}<ChevronDown size={12} class="shrink-0 text-subtle" aria-hidden="true" />{/if}
</button>

<Popover bind:open {anchor} label={label ?? placeholder} onclose={close} class="z-50 w-60 p-1">
  {#if items.length > 7}
    <input
      bind:this={searchEl}
      bind:value={query}
      placeholder="Search…"
      class="mb-1 h-7 w-full rounded border border-line bg-bg px-2 text-xs outline-none focus:border-accent"
      onkeydown={(e) => {
        if (e.key === 'Enter' && shown[0]) {
          e.preventDefault();
          toggle(shown[0].id);
        }
      }}
    />
  {/if}
  <ul role="listbox" aria-multiselectable={multi} class="max-h-64 overflow-auto">
    {#if allowNone && !multi}
      <li>
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-muted hover:bg-surface-2"
          onclick={() => {
            onchange([]);
            close();
          }}>None</button
        >
      </li>
    {/if}
    {#each shown as item (item.id)}
      {@const on = selected.includes(item.id)}
      <!-- aria-label: a person row is often only an avatar, which names nothing. -->
      <li role="option" aria-selected={on} aria-label={item.label}>
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-2"
          onclick={() => toggle(item.id)}
        >
          <span class="grid size-3.5 shrink-0 place-items-center">
            {#if on}<Check size={12} class="text-accent" />{/if}
          </span>
          {#if item.uid}
            <PersonChip
              uid={item.uid}
              layout="compact"
              size={18}
              suffix={item.label === 'Me' ? '(me)' : undefined}
            />
          {:else}
            {#if item.indicator}<Indicator
                indicator={item.indicator}
                size="sm"
              />{:else if item.color}<span
                class="size-2.5 shrink-0 rounded-full"
                style="background:{item.color}"
              ></span>{/if}
            <span class="truncate" title={item.hint || undefined}>{item.label}</span>
          {/if}
        </button>
      </li>
    {:else}
      <li class="px-2 py-1.5 text-xs text-muted">Nothing matches</li>
    {/each}
  </ul>
</Popover>

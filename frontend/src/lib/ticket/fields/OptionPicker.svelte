<!--
  A searchable single / multi picker in a popover — stages, priorities, tags,
  select fields and people all use it.
  <OptionPicker options={[{ id, name, color }]} value={[id]} onchange={(ids) => …} />
  People: give options a `uid` (avatar) and `detail` (email).
-->
<script lang="ts" module>
  export interface PickOption {
    id: string;
    name: string;
    color?: string | null;
    /** Second line / right side (a person's email, a stage's category). */
    detail?: string;
    /** Draw the person's avatar. */
    uid?: string;
    disabled?: boolean;
  }
</script>

<script lang="ts">
  import { Check, ChevronDown, Plus, X } from 'lucide-svelte';
  import { Popover } from '$lib/ui';
  import PersonAvatar from '../PersonAvatar.svelte';

  interface Props {
    options: PickOption[];
    value: string[];
    multiple?: boolean;
    /** Single mode: offer 'None'. */
    clearable?: boolean;
    placeholder?: string;
    label: string;
    disabled?: boolean;
    onchange: (ids: string[]) => void;
    /** '+ Create "…"' for a query with no exact match. Resolves the new id (or null). */
    oncreate?: (name: string) => Promise<string | null>;
    class?: string;
  }
  let {
    options,
    value,
    multiple = false,
    clearable = false,
    placeholder = 'None',
    label,
    disabled = false,
    onchange,
    oncreate,
    class: cls = '',
  }: Props = $props();

  let open = $state(false);
  let anchor: HTMLButtonElement | null = $state(null);
  let q = $state('');
  let index = $state(0);
  let creating = $state(false);

  const selected = $derived(
    value.map((id) => options.find((o) => o.id === id) ?? { id, name: 'Removed', color: null }),
  );
  const filtered = $derived.by(() => {
    const s = q.trim().toLowerCase();
    return s
      ? options.filter(
          (o) => o.name.toLowerCase().includes(s) || (o.detail ?? '').toLowerCase().includes(s),
        )
      : options;
  });
  const canCreate = $derived(
    !!oncreate &&
      q.trim().length > 0 &&
      !options.some((o) => o.name.toLowerCase() === q.trim().toLowerCase()),
  );

  function toggle(o: PickOption) {
    if (o.disabled) return;
    if (multiple) {
      onchange(value.includes(o.id) ? value.filter((v) => v !== o.id) : [...value, o.id]);
    } else {
      open = false;
      if (value[0] !== o.id) onchange([o.id]);
    }
  }
  async function create() {
    if (!oncreate || creating) return;
    creating = true;
    const id = await oncreate(q.trim());
    creating = false;
    if (id) {
      q = '';
      onchange(multiple ? [...value, id] : [id]);
      if (!multiple) open = false;
    }
  }
  function onkeydown(e: KeyboardEvent) {
    const n = filtered.length + (canCreate ? 1 : 0);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      index = n ? (index + 1) % n : 0;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      index = n ? (index - 1 + n) % n : 0;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (index < filtered.length) toggle(filtered[index]!);
      else if (canCreate) void create();
    }
  }
  $effect(() => {
    void q;
    index = 0;
  });
  $effect(() => {
    if (!open) q = '';
  });
</script>

<button
  bind:this={anchor}
  type="button"
  {disabled}
  aria-haspopup="listbox"
  aria-expanded={open}
  aria-label={label}
  onclick={() => (open = !open)}
  class="group flex min-h-8 w-full items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-left text-sm
    hover:border-line hover:bg-surface-2 disabled:cursor-default disabled:hover:border-transparent disabled:hover:bg-transparent {cls}"
>
  <span class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
    {#if !selected.length}
      <span class="text-subtle">{placeholder}</span>
    {:else}
      {#each selected as o (o.id)}
        {#if o.uid}
          <span class="inline-flex max-w-full items-center gap-1.5">
            <PersonAvatar uid={o.uid} size={18} /><span class="truncate">{o.name}</span>
          </span>
        {:else if multiple}
          <span
            class="inline-flex h-5 items-center gap-1 rounded-full bg-surface-2 px-2 text-xs"
            style={o.color ? `background: color-mix(in srgb, ${o.color} 18%, transparent)` : ''}
          >
            {#if o.color}<span class="size-1.5 rounded-full" style="background:{o.color}"
              ></span>{/if}{o.name}
          </span>
        {:else}
          <span class="inline-flex min-w-0 items-center gap-1.5">
            {#if o.color}<span class="size-2 shrink-0 rounded-full" style="background:{o.color}"
              ></span>{/if}
            <span class="truncate">{o.name}</span>
          </span>
        {/if}
      {/each}
    {/if}
  </span>
  {#if !disabled}<ChevronDown
      size={14}
      class="shrink-0 text-subtle opacity-0 group-hover:opacity-100"
      aria-hidden="true"
    />{/if}
</button>

<Popover bind:open {anchor} {label} class="w-64 p-1">
  <!-- svelte-ignore a11y_autofocus -->
  <input
    type="text"
    bind:value={q}
    {onkeydown}
    autofocus
    placeholder={oncreate ? 'Search or create…' : 'Search…'}
    aria-label="Search {label}"
    class="mb-1 h-8 w-full rounded-md border border-line bg-surface px-2 text-sm focus:border-accent focus:outline-none"
  />
  <div role="listbox" aria-multiselectable={multiple} class="max-h-64 overflow-y-auto">
    {#if clearable && !multiple && value.length && !q}
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-2"
        onclick={() => {
          open = false;
          onchange([]);
        }}
      >
        <X size={14} aria-hidden="true" /> Clear
      </button>
    {/if}
    {#each filtered as o, i (o.id)}
      {@const on = value.includes(o.id)}
      <button
        type="button"
        role="option"
        aria-selected={on}
        aria-disabled={o.disabled || undefined}
        onclick={() => toggle(o)}
        onmouseenter={() => (index = i)}
        class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm aria-disabled:opacity-40
          {i === index ? 'bg-surface-2' : ''}"
      >
        {#if o.uid}
          <PersonAvatar uid={o.uid} size={22} />
          <span class="flex min-w-0 flex-1 flex-col leading-tight">
            <span class="truncate">{o.name}</span>
            {#if o.detail}<span class="truncate text-xs text-muted">{o.detail}</span>{/if}
          </span>
        {:else}
          {#if o.color}<span class="size-2.5 shrink-0 rounded-full" style="background:{o.color}"
            ></span>{/if}
          <span class="min-w-0 flex-1 truncate">{o.name}</span>
          {#if o.detail}<span class="shrink-0 text-xs text-subtle">{o.detail}</span>{/if}
        {/if}
        {#if on}<Check size={14} class="shrink-0 text-accent" aria-hidden="true" />{/if}
      </button>
    {/each}
    {#if canCreate}
      <button
        type="button"
        onclick={create}
        onmouseenter={() => (index = filtered.length)}
        disabled={creating}
        class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm {index ===
        filtered.length
          ? 'bg-surface-2'
          : ''}"
      >
        <Plus size={14} aria-hidden="true" /> Create “{q.trim()}”
      </button>
    {:else if !filtered.length}
      <p class="px-2 py-1.5 text-sm text-muted">No matches</p>
    {/if}
  </div>
</Popover>

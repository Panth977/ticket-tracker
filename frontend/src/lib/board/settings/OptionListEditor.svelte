<!--
  Option list editor (app.json components › Option list editor): priorities,
  tags, select choices and — with a `row` snippet for the extras — stages.
  Rename in place, pick a colour, drag (or ↑/↓) to reorder, remove, add.
  Positions are renumbered 0..n-1 on every change; ids never change.
-->
<script
  lang="ts"
  generics="T extends { id: string; name: string; color?: string; position: number }"
>
  import type { Snippet } from 'svelte';
  import { dragHandle, dragHandleZone, type DndEvent } from 'svelte-dnd-action';
  import { flip } from 'svelte/animate';
  import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from 'lucide-svelte';
  import { PALETTE } from '$lib/ui/ColorSwatch.svelte';
  import ColorPick from './ColorPick.svelte';
  import { localId, renumber } from './draft.svelte';

  interface Props {
    items: T[];
    onchange: (items: T[]) => void;
    /** Build a new item (defaults: name, colour, id). */
    make?: (base: { id: string; name: string; color: string; position: number }) => T;
    colors?: boolean;
    readOnly?: boolean;
    addLabel?: string;
    /** Minimum items (stages need one). */
    min?: number;
    /** Extra editors under each row (stage category, WIP, requires). */
    row?: Snippet<[T, (patch: Partial<T>) => void]>;
    /** Drawn instead of the colour pick (stages: the indicator, indicators.html). */
    lead?: Snippet<[T, (patch: Partial<T>) => void]>;
    /** Why an item can't be removed (null = it can). */
    removeBlocked?: (item: T) => string | null;
    label?: string;
  }
  let {
    items,
    onchange,
    make = (b) => b as unknown as T,
    colors = true,
    readOnly = false,
    addLabel = 'Add',
    min = 0,
    row,
    lead,
    removeBlocked,
    label = 'Options',
  }: Props = $props();

  const FLIP = 150;
  // dnd needs a local copy it can reorder while dragging.
  let local = $state<T[]>([]);
  let dragging = false;
  $effect(() => {
    const next = items;
    if (!dragging) local = next;
  });

  const emit = (xs: T[]) => onchange(renumber(xs));
  function patch(i: number, p: Partial<T>) {
    emit(local.map((x, j) => (j === i ? { ...x, ...p } : x)));
  }
  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= local.length) return;
    const xs = [...local];
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    emit(xs);
  }
  function remove(i: number) {
    emit(local.filter((_, j) => j !== i));
  }
  let newName = $state('');
  function add(e: SubmitEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const color = PALETTE[local.length % PALETTE.length]!;
    emit([
      ...local,
      make({ id: localId(local.map((x) => x.id)), name, color, position: local.length }),
    ]);
    newName = '';
  }
  function consider(e: CustomEvent<DndEvent<T>>) {
    dragging = true;
    local = e.detail.items;
  }
  function finalize(e: CustomEvent<DndEvent<T>>) {
    dragging = false;
    local = e.detail.items;
    emit(e.detail.items);
  }
</script>

<div class="flex flex-col gap-2">
  <ul
    class="flex flex-col gap-1.5"
    aria-label={label}
    use:dragHandleZone={{
      items: local,
      flipDurationMs: FLIP,
      dragDisabled: readOnly,
      dropTargetStyle: {},
      type: label,
    }}
    onconsider={consider}
    onfinalize={finalize}
  >
    {#each local as item, i (item.id)}
      {@const blocked = removeBlocked?.(item) ?? null}
      <li animate:flip={{ duration: FLIP }} class="rounded-md border border-line bg-surface">
        <div class="flex items-center gap-2 px-2 py-1.5">
          {#if !readOnly}<span
              use:dragHandle
              aria-label="Drag {item.name}"
              class="shrink-0 cursor-grab text-subtle"><GripVertical size={14} /></span
            >{/if}
          {#if lead}
            {@render lead(item, (p) => patch(i, p))}
          {:else if colors}
            <ColorPick
              value={item.color}
              label="Colour of {item.name}"
              disabled={readOnly}
              onchange={(c) => patch(i, { color: c } as Partial<T>)}
            />
          {/if}
          <input
            class="h-8 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 text-sm outline-none hover:border-line focus:border-accent disabled:hover:border-transparent"
            value={item.name}
            maxlength={60}
            disabled={readOnly}
            aria-label="Name"
            onchange={(e) => {
              const v = e.currentTarget.value.trim();
              if (v) patch(i, { name: v } as Partial<T>);
              else e.currentTarget.value = item.name;
            }}
          />
          {#if !readOnly}
            <button
              type="button"
              class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2 disabled:opacity-30"
              aria-label="Move {item.name} up"
              disabled={i === 0}
              onclick={() => move(i, -1)}><ArrowUp size={13} /></button
            >
            <button
              type="button"
              class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2 disabled:opacity-30"
              aria-label="Move {item.name} down"
              disabled={i === local.length - 1}
              onclick={() => move(i, 1)}><ArrowDown size={13} /></button
            >
            <button
              type="button"
              class="grid size-7 place-items-center rounded text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-30"
              aria-label="Remove {item.name}"
              title={blocked ?? undefined}
              disabled={local.length <= min || blocked != null}
              onclick={() => remove(i)}><Trash2 size={13} /></button
            >
          {/if}
        </div>
        {#if row}
          <div class="border-t border-line px-3 py-2">{@render row(item, (p) => patch(i, p))}</div>
        {/if}
      </li>
    {/each}
  </ul>
  {#if !readOnly}
    <form class="flex items-center gap-2" onsubmit={add}>
      <input
        bind:value={newName}
        maxlength={60}
        placeholder="New name…"
        aria-label="New {label} name"
        class="h-8 w-60 rounded-md border border-line bg-surface px-2 text-sm outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={!newName.trim()}
        class="flex h-8 items-center gap-1 rounded-md border border-line px-2.5 text-sm hover:bg-surface-2 disabled:opacity-50"
      >
        <Plus size={13} />{addLabel}
      </button>
    </form>
  {/if}
</div>

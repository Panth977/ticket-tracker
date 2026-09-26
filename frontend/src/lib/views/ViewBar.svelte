<!--
  View bar (app.json components › View bar):
    Board  Table  Mine ●  +   ·   Filter 2   Sort   Group: Stage   Save view ▾
  The tabs are the board's saved views (shared ∪ my personal ones — the same
  list the sidebar shows). ● = the open view has unsaved changes: Save, or
  'Save as personal'. Everything edited here changes the DRAFT only.
-->
<script lang="ts">
  // hrefs are built with lib/layout/routes (no base path in this SPA).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import {
    ArrowUpDown,
    ChevronDown,
    Filter,
    LayoutGrid,
    Lock,
    Plus,
    SlidersHorizontal,
  } from 'lucide-svelte';
  import type { Board, View, ViewInput, ViewType } from '@tm/shared';
  import { VIEW_TYPES } from '@tm/shared';
  import Popover from '$lib/ui/Popover.svelte';
  import Menu from '$lib/ui/Menu.svelte';
  import type { MenuItem } from '$lib/ui/types';
  import { routes } from '$lib/layout/routes';
  import FilterBuilder from './FilterBuilder.svelte';
  import SortEditor from './SortEditor.svelte';
  import LayoutEditor from './LayoutEditor.svelte';
  import { countConditions } from './filter';
  import { fieldInfo } from './fields';
  import { VIEW_TYPE_LABEL, withType } from './draft';

  interface Props {
    boardKey: string;
    board: Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields' | 'defaultViewId'>;
    views: (View & { id: string })[];
    viewId: string;
    draft: ViewInput;
    dirty: boolean;
    people: { uid: string; name: string; email: string }[];
    /** Save over the open view (hidden when I may not). */
    canSave: boolean;
    canDelete: boolean;
    canSaveShared: boolean;
    onchange: (draft: ViewInput) => void;
    onsave: () => void;
    onsaveas: (scope: 'personal' | 'shared') => void;
    onreset: () => void;
    onrename: () => void;
    ondelete: () => void;
    onnew: () => void;
    onmakedefault: () => void;
    isAdmin: boolean;
  }
  let {
    boardKey,
    board,
    views,
    viewId,
    draft,
    dirty,
    people,
    canSave,
    canDelete,
    canSaveShared,
    onchange,
    onsave,
    onsaveas,
    onreset,
    onrename,
    ondelete,
    onnew,
    onmakedefault,
    isAdmin,
  }: Props = $props();

  let filterOpen = $state(false);
  let sortOpen = $state(false);
  let layoutOpen = $state(false);
  let filterBtn: HTMLButtonElement | null = $state(null);
  let sortBtn: HTMLButtonElement | null = $state(null);
  let layoutBtn: HTMLButtonElement | null = $state(null);

  const nFilters = $derived(countConditions(draft.filter));
  const groupLabel = $derived(
    draft.groupBy ? (fieldInfo(board, draft.groupBy)?.label ?? draft.groupBy) : null,
  );

  const saveItems = $derived.by((): MenuItem[] => {
    const items: MenuItem[] = [];
    if (canSave) items.push({ label: 'Save view', onSelect: onsave, disabled: !dirty });
    items.push({ label: 'Save as personal view…', onSelect: () => onsaveas('personal') });
    if (canSaveShared)
      items.push({ label: 'Save as shared view…', onSelect: () => onsaveas('shared') });
    if (dirty) items.push({ label: 'Discard changes', onSelect: onreset });
    if (canSave) items.push({ label: 'Rename…', onSelect: onrename, separator: true });
    if (isAdmin && viewId !== board.defaultViewId && draft.scope === 'shared')
      items.push({ label: "Make the board's default view", onSelect: onmakedefault });
    if (canDelete)
      items.push({ label: 'Delete view', onSelect: ondelete, danger: true, separator: true });
    return items;
  });
</script>

<div
  class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-4 py-1.5"
>
  <nav aria-label="Views" class="-mb-1.5 flex min-w-0 items-end gap-0.5 overflow-x-auto">
    {#each views as v (v.id)}
      {@const current = v.id === viewId}
      <a
        href={routes.board(boardKey, v.id)}
        aria-current={current ? 'page' : undefined}
        class="flex h-8 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-sm whitespace-nowrap
          {current
          ? 'border-accent font-medium text-text'
          : 'border-transparent text-muted hover:text-text'}"
      >
        {#if v.scope === 'personal'}<Lock
            size={11}
            class="text-subtle"
            aria-label="Personal view"
          />{/if}
        {v.name}
        {#if current && dirty}<span
            class="size-1.5 rounded-full bg-accent"
            title="Unsaved changes"
            aria-label="Unsaved changes"
          ></span>{/if}
      </a>
    {/each}
    <button
      type="button"
      class="mb-1.5 grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
      aria-label="New view"
      title="New view"
      onclick={onnew}><Plus size={15} /></button
    >
  </nav>

  <div class="ml-auto flex flex-wrap items-center gap-1">
    <label class="sr-only" for="view-type">Layout</label>
    <select
      id="view-type"
      class="h-7 rounded-md border border-line bg-surface px-1.5 text-xs"
      value={draft.type}
      onchange={(e) => onchange(withType(draft, e.currentTarget.value as ViewType))}
    >
      {#each VIEW_TYPES as t (t)}<option value={t}>{VIEW_TYPE_LABEL[t]}</option>{/each}
    </select>

    <button
      bind:this={filterBtn}
      type="button"
      onclick={() => (filterOpen = !filterOpen)}
      aria-expanded={filterOpen}
      class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-surface-2 {nFilters
        ? 'bg-accent-soft text-accent'
        : 'text-muted'}"
    >
      <Filter size={13} /> Filter{#if nFilters}<span class="font-semibold">{nFilters}</span>{/if}
    </button>
    <button
      bind:this={sortBtn}
      type="button"
      onclick={() => (sortOpen = !sortOpen)}
      aria-expanded={sortOpen}
      class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-surface-2 {draft
        .sort.length
        ? 'bg-accent-soft text-accent'
        : 'text-muted'}"
    >
      <ArrowUpDown size={13} /> Sort{#if draft.sort.length}<span class="font-semibold"
          >{draft.sort.length}</span
        >{/if}
    </button>
    <button
      bind:this={layoutBtn}
      type="button"
      onclick={() => (layoutOpen = !layoutOpen)}
      aria-expanded={layoutOpen}
      class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-surface-2"
    >
      {#if draft.type === 'kanban' || draft.type === 'table'}
        <LayoutGrid size={13} /> {groupLabel ? `Group: ${groupLabel}` : 'Group'}
      {:else}
        <SlidersHorizontal size={13} /> Options
      {/if}
    </button>

    <Menu items={saveItems} placement="bottom-end">
      {#snippet trigger(p)}
        <button
          type="button"
          {...p}
          class="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs
            {dirty
            ? 'border-accent bg-accent text-accent-fg'
            : 'border-line text-muted hover:bg-surface-2'}"
        >
          {dirty ? 'Save view' : 'View'}
          <ChevronDown size={12} />
        </button>
      {/snippet}
    </Menu>
  </div>
</div>

<Popover
  bind:open={filterOpen}
  anchor={filterBtn}
  placement="bottom-end"
  label="Filter"
  class="z-40"
>
  <FilterBuilder
    filter={draft.filter}
    {board}
    {people}
    onchange={(filter) => onchange({ ...draft, filter })}
  />
</Popover>
<Popover bind:open={sortOpen} anchor={sortBtn} placement="bottom-end" label="Sort" class="z-40">
  <SortEditor sort={draft.sort} {board} onchange={(sort) => onchange({ ...draft, sort })} />
</Popover>
<Popover
  bind:open={layoutOpen}
  anchor={layoutBtn}
  placement="bottom-end"
  label="View options"
  class="z-40"
>
  <LayoutEditor {draft} {board} {onchange} />
</Popover>

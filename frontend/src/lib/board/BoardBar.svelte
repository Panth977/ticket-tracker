<!--
  THE board toolbar (agents.html §Q2, §U). One row, not two — on a phone too:
  below sm the labels and the keyboard hints fold away and the icons stay, so
  the controls never wrap into a second row.


    ● VDP VardayiniApp ☆ $402 │ Board  Table  Calendar  Mine  +     🔎  Filter 2  Sort  Group: Stage  🔔 Mine  ⚙  + New

  Left  — the board is the page title (colour dot, key, name, star), then the
          board's lifetime agent cost (§Y2 — a chip that opens Analytics, drawn
          once it is non-zero), then the board's saved views as tabs (shared ∪
          my personal ones).
  Right — everything that acts on what you are looking at.

  The active tab is also its own menu: save / discard / save as / rename /
  make default / delete, and which layout the view uses. There is no separate
  'View ▾' button and no second bar — one door per thing (§Q2).

  ⚙ goes to board settings, which is where People & roles lives now (§Q2), so
  it is shown to everyone: non-admins read it and can see who is on the board.
-->
<script lang="ts">
  // hrefs are built with lib/layout/routes (no base path in this SPA).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import {
    ArrowUpDown,
    Check,
    ChevronDown,
    Filter,
    LayoutGrid,
    Lock,
    Plus,
    Search,
    Settings,
    SlidersHorizontal,
    Star,
  } from 'lucide-svelte';
  import type { Board, BoardPref, View, ViewInput, ViewType } from '@tm/shared';
  import { VIEW_TYPES } from '@tm/shared';
  import type { WithId } from '$lib/stores';
  import { switcherFor } from '$lib/workspaces/switcherStore';
  import WorkspaceCrumb from '$lib/workspaces/WorkspaceCrumb.svelte';
  import TitleSwitcher from '$lib/workspaces/TitleSwitcher.svelte';
  import { workspaceContext } from '$lib/workspaces/context.svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { fmtTurns, fmtUsd, fmtUsdExact } from '$lib/cost/format';
  import Popover from '$lib/ui/Popover.svelte';
  import Menu from '$lib/ui/Menu.svelte';
  import Button from '$lib/ui/Button.svelte';
  import ColorSwatch from '$lib/ui/ColorSwatch.svelte';
  import Kbd from '$lib/ui/Kbd.svelte';
  import type { MenuItem } from '$lib/ui/types';
  import { routes } from '$lib/layout/routes';
  import FilterBuilder from '$lib/views/FilterBuilder.svelte';
  import SortEditor from '$lib/views/SortEditor.svelte';
  import LayoutEditor from '$lib/views/LayoutEditor.svelte';
  import { countConditions } from '$lib/views/filter';
  import { fieldInfo } from '$lib/views/fields';
  import { VIEW_TYPE_LABEL, withType } from '$lib/views/draft';
  import Avatars from './Avatars.svelte';
  import NotifyMenu from './NotifyMenu.svelte';

  interface Props {
    /** Always a loaded board — the route holds its skeleton until then (§Q4). */
    board: WithId<Board>;
    views: WithId<View>[];
    viewId: string;
    draft: ViewInput;
    dirty: boolean;
    people: { uid: string; name: string; email: string }[];
    /** Other people looking at this board right now. */
    online: string[];
    me: string;
    pref: BoardPref | null;
    starred: boolean;
    /** Save over the open view (hidden when I may not). */
    canSave: boolean;
    canDelete: boolean;
    canSaveShared: boolean;
    canCreate: boolean;
    isAdmin: boolean;
    /** Free-text search over this view — bound, so '/' can focus the box. */
    search: string;
    onchange: (draft: ViewInput) => void;
    onsave: () => void;
    onsaveas: (scope: 'personal' | 'shared') => void;
    onreset: () => void;
    onrename: () => void;
    ondelete: () => void;
    onnew: () => void;
    onmakedefault: () => void;
    onstar: () => void;
    onnewticket: () => void;
  }
  let {
    board,
    views,
    viewId,
    draft,
    dirty,
    people,
    online,
    me,
    pref,
    starred,
    canSave,
    canDelete,
    canSaveShared,
    canCreate,
    isAdmin,
    search = $bindable(),
    onchange,
    onsave,
    onsaveas,
    onreset,
    onrename,
    ondelete,
    onnew,
    onmakedefault,
    onstar,
    onnewticket,
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

  /** The open tab's own menu: what you can do to this view. */
  const viewItems = $derived.by((): MenuItem[] => {
    const items: MenuItem[] = [];
    if (canSave)
      items.push({
        label: dirty ? 'Save changes' : 'Save view',
        onSelect: onsave,
        disabled: !dirty,
      });
    if (dirty) items.push({ label: 'Discard changes', onSelect: onreset });
    items.push({
      label: 'Save as personal view…',
      onSelect: () => onsaveas('personal'),
      separator: true,
    });
    if (canSaveShared)
      items.push({ label: 'Save as shared view…', onSelect: () => onsaveas('shared') });
    if (canSave) items.push({ label: 'Rename…', onSelect: onrename, separator: true });
    if (isAdmin && viewId !== board.defaultViewId && draft.scope === 'shared')
      items.push({ label: "Make the board's default view", onSelect: onmakedefault });
    // The layout used to be a select of its own in the second bar; it belongs
    // to the view, so it lives with the view's other settings.
    items.push(
      ...VIEW_TYPES.map((t, i) => ({
        label: `Show as ${VIEW_TYPE_LABEL[t].toLowerCase()}`,
        icon: t === draft.type ? Check : undefined,
        onSelect: () => onchange(withType(draft, t as ViewType)),
        separator: i === 0,
      })),
    );
    if (canDelete)
      items.push({ label: 'Delete view', onSelect: ondelete, danger: true, separator: true });
    return items;
  });

  // The title is also the board switcher: every board I am on, this one marked —
  // or, when I came here through a workspace that holds this board (§AB3),
  // only that workspace's boards and artifacts.
  const switchQ = $derived(switcherFor(auth.uid, { boardId: board.id }, workspaceContext.id));
  const workspace = $derived($switchQ.workspace);
  const boardItems = $derived($switchQ.items);
</script>

<header
  class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-4 py-1.5"
>
  <!-- The board IS the page title. -->
  <div class="flex min-w-0 items-center gap-2">
    {#if workspace}
      <!-- §AB3: where I came from; one click back to the workspace page. -->
      <WorkspaceCrumb {workspace} />
    {/if}
    <ColorSwatch color={board.color} size={10} />
    <TitleSwitcher kind="board" items={boardItems} name={board.name} prefix={board.key} />
    <button
      type="button"
      class="tm-tap grid size-7 shrink-0 place-items-center rounded text-subtle hover:bg-surface-2 hover:text-warning"
      aria-pressed={starred}
      aria-label={starred ? 'Unstar board' : 'Star board'}
      onclick={onstar}
    >
      <Star size={15} class={starred ? 'fill-current text-warning' : ''} />
    </button>
    {#if board.cost && board.cost.usd > 0}
      <!-- §Y2: the board's lifetime agent cost; §Y3: the chip is the door to Analytics. -->
      <a
        href={routes.boardAnalytics(board.key)}
        data-board-cost
        class="tm-tap inline-flex h-6 shrink-0 items-center rounded-full bg-surface-2 px-2 text-xs font-medium text-muted tabular-nums hover:bg-surface-3 hover:text-text"
        title="{fmtUsdExact(board.cost.usd)} in agent turns over {fmtTurns(
          board.cost.runs,
        )} — open Analytics"
        aria-label="Analytics — {fmtUsdExact(board.cost.usd)} in agent turns"
      >
        {fmtUsd(board.cost.usd)}
      </a>
    {/if}
    {#if online.length}
      <span class="hidden lg:inline" title="Also here now"
        ><Avatars uids={online} size={20} max={4} /></span
      >
    {/if}
  </div>

  <nav
    aria-label="Views"
    class="-mb-1.5 flex min-w-0 items-end gap-0.5 overflow-x-auto md:border-l md:border-line md:pl-3"
  >
    {#each views as v (v.id)}
      {#if v.id === viewId}
        <!-- The open tab doubles as its menu (save / rename / layout / delete). -->
        <Menu items={viewItems} placement="bottom-start">
          {#snippet trigger(p)}
            <button
              type="button"
              {...p}
              data-view-tab={v.id}
              aria-current="page"
              title={dirty ? 'Unsaved changes — open this menu to save' : 'This view'}
              class="flex h-8 shrink-0 items-center gap-1.5 border-b-2 border-accent px-2.5 text-sm font-medium
                whitespace-nowrap text-text"
            >
              {#if v.scope === 'personal'}<Lock
                  size={11}
                  class="text-subtle"
                  aria-label="Personal view"
                />{/if}
              {v.name}
              {#if dirty}<span
                  class="size-1.5 rounded-full bg-accent"
                  title="Unsaved changes"
                  aria-label="Unsaved changes"
                ></span>{/if}
              <ChevronDown size={12} class="text-subtle" />
            </button>
          {/snippet}
        </Menu>
      {:else}
        <a
          href={routes.board(board.key, v.id)}
          data-view-tab={v.id}
          class="flex h-8 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-sm whitespace-nowrap
            text-muted hover:text-text"
        >
          {#if v.scope === 'personal'}<Lock
              size={11}
              class="text-subtle"
              aria-label="Personal view"
            />{/if}
          {v.name}
        </a>
      {/if}
    {/each}
    <button
      type="button"
      class="tm-tap mb-1.5 grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
      aria-label="New view"
      title="New view"
      onclick={onnew}><Plus size={15} /></button
    >
  </nav>

  <div class="ml-auto flex flex-wrap items-center gap-1">
    <label class="relative flex items-center">
      <span class="sr-only">Search this view</span>
      <Search size={14} class="pointer-events-none absolute left-2 text-subtle" />
      <input
        data-search
        type="search"
        bind:value={search}
        placeholder="Search"
        class="h-7 w-24 rounded-md border border-line bg-bg pr-2 pl-7 text-sm outline-none focus:w-44 sm:w-36 sm:pr-7 sm:focus:w-56 focus:border-accent"
        onkeydown={(e) => e.key === 'Escape' && ((search = ''), e.currentTarget.blur())}
      />
      <Kbd keys="/" class="pointer-events-none absolute right-1.5 hidden sm:block" />
    </label>

    <button
      bind:this={filterBtn}
      type="button"
      onclick={() => (filterOpen = !filterOpen)}
      aria-expanded={filterOpen}
      class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-surface-2 {nFilters
        ? 'bg-accent-soft text-accent'
        : 'text-muted'}"
    >
      <Filter size={13} /><span class="sr-only sm:not-sr-only sm:inline">Filter</span
      >{#if nFilters}<span class="font-semibold">{nFilters}</span>{/if}
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
      <ArrowUpDown size={13} /><span class="sr-only sm:not-sr-only sm:inline">Sort</span
      >{#if draft.sort.length}<span class="font-semibold">{draft.sort.length}</span>{/if}
    </button>
    <button
      bind:this={layoutBtn}
      type="button"
      onclick={() => (layoutOpen = !layoutOpen)}
      aria-expanded={layoutOpen}
      class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-surface-2"
    >
      {#if draft.type === 'kanban' || draft.type === 'table'}
        <LayoutGrid size={13} /><span class="sr-only sm:not-sr-only sm:inline"
          >{groupLabel ? `Group: ${groupLabel}` : 'Group'}</span
        >
      {:else}
        <SlidersHorizontal size={13} /><span class="sr-only sm:not-sr-only sm:inline">Options</span>
      {/if}
    </button>

    {#if me}<NotifyMenu boardId={board.id} uid={me} {pref} />{/if}
    <a
      href={routes.boardSettings(board.key)}
      data-board-settings
      title="Board settings — stages, fields, people &amp; roles"
      aria-label="Board settings"
      class="tm-tap grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
    >
      <Settings size={15} />
    </a>
    {#if canCreate}
      <!-- §U: on a phone the primary action is the + alone, so the bar stays one row. -->
      <Button variant="primary" icon={Plus} aria-label="New ticket" onclick={onnewticket}>
        <span class="sr-only sm:not-sr-only sm:inline">New</span>
        <Kbd keys="c" class="ml-1 hidden opacity-70 sm:inline-flex" />
      </Button>
    {/if}
  </div>
</header>

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

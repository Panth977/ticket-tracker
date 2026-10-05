<!--
  Table (app.json components › Table):
    ☐  Key  Title  Stage  Assignee  Due  Client  Estimate
  Virtualised rows (only what is on screen is in the DOM), inline cell editors
  per FieldType, and the column layout (order, widths, hidden) lives in the
  VIEW — edits here change the draft, 'Save view' keeps them — not localStorage.
  Selecting rows shows the bulk bar (ticketBulk: one call, many tickets).
-->
<script lang="ts">
  import {
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    ChevronDown,
    EyeOff,
    Plus,
  } from 'lucide-svelte';
  import type { ViewInput } from '@tm/shared';
  import { ALL_KEY, type ViewGroup } from '@tm/shared/logic/view';
  import Menu from '$lib/ui/Menu.svelte';
  import PersonChip from '$lib/ui/PersonChip.svelte';
  import Indicator from '$lib/ui/Indicator.svelte';
  import type { MenuItem } from '$lib/ui/types';
  import { boardFields, fieldInfo } from '$lib/views/fields';
  import { DEFAULT_COLUMNS } from '$lib/views/draft';
  import { groupLabel, isPeopleGroup } from '$lib/views/format';
  import BulkBar from './BulkBar.svelte';
  import TableCell from './TableCell.svelte';
  import { useBoard, type BoardDoc, type BoardTicket } from './context.svelte';

  interface Props {
    /** The loaded board (§Q4) — never null. */
    board: BoardDoc;
    groups: ViewGroup<BoardTicket>[];
    view: ViewInput;
    onchange: (view: ViewInput) => void;
  }
  let { board, groups, view, onchange }: Props = $props();
  const bs = useBoard();

  const ROW = 36;
  const OVERSCAN = 8;
  const SELECT_W = 36;

  type Col = ViewInput['columns'][number];
  /**
   * TWO COLUMNS THAT ARE NOT TICKET FIELDS. 'chat' is the thread (the unread
   * count); 'activity' is what is going on with the ticket (a question waiting
   * for an answer, the task list, files, blocked, cost, the agent's dot). They
   * used to be packed in front of the title. They are ordinary columns in the
   * view — moved, resized, hidden and saved like any other — and a view saved
   * before they existed gets them right after the title the first time it is
   * drawn (a view that HID them names them with `hidden`, so that is kept).
   */
  const EXTRA: Record<string, { label: string; width: number }> = {
    chat: { label: 'Chat', width: 64 },
    activity: { label: 'Activity', width: 230 },
  };
  function withExtras(list: readonly Col[]): Col[] {
    const out = [...list];
    let at = out.findIndex((c) => c.field === 'title') + 1;
    for (const field of Object.keys(EXTRA)) {
      const i = out.findIndex((c) => c.field === field);
      if (i >= 0) at = Math.max(at, i + 1);
      else out.splice(at++, 0, { field, width: EXTRA[field]!.width });
    }
    return out;
  }
  const allCols = $derived<Col[]>(withExtras(view.columns.length ? view.columns : DEFAULT_COLUMNS));
  const cols = $derived(
    allCols.filter(
      (c) =>
        !c.hidden &&
        (c.field === 'key' || c.field === 'title' || c.field in EXTRA || fieldInfo(board, c.field)),
    ),
  );
  const totalWidth = $derived(SELECT_W + cols.reduce((n, c) => n + c.width, 0));

  type Row =
    { kind: 'group'; g: ViewGroup<BoardTicket> } | { kind: 'ticket'; t: BoardTicket; gk: string };
  let collapsed = $state<Set<string>>(new Set());
  const grouped = $derived(!(groups.length === 1 && groups[0]!.key === ALL_KEY));
  const rows = $derived.by((): Row[] => {
    const out: Row[] = [];
    for (const g of groups) {
      if (grouped) out.push({ kind: 'group', g });
      if (!grouped || !collapsed.has(g.key))
        for (const t of g.tickets) out.push({ kind: 'ticket', t, gk: g.key });
    }
    return out;
  });
  const tickets = $derived([
    ...new Map(groups.flatMap((g) => g.tickets).map((t) => [t.id, t])).values(),
  ]);

  // ── virtualisation ──
  let scroller: HTMLDivElement | null = $state(null);
  let scrollTop = $state(0);
  let viewport = $state(600);
  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN));
  const last = $derived(Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW) + OVERSCAN));
  const slice = $derived(rows.slice(first, last));
  $effect(() => {
    if (!scroller) return;
    const ro = new ResizeObserver(() => (viewport = scroller?.clientHeight ?? 600));
    ro.observe(scroller);
    return () => ro.disconnect();
  });

  // ── selection ──
  let selected = $state<Set<string>>(new Set());
  let anchor: string | null = null;
  // Drop selected tickets that left the view.
  $effect(() => {
    const ids = new Set(tickets.map((t) => t.id));
    if ([...selected].some((id) => !ids.has(id)))
      selected = new Set([...selected].filter((id) => ids.has(id)));
  });
  const allOn = $derived(tickets.length > 0 && tickets.every((t) => selected.has(t.id)));
  function toggleAll() {
    selected = allOn ? new Set() : new Set(tickets.map((t) => t.id));
  }
  function toggle(id: string, e: MouseEvent) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a fresh copy, assigned wholesale below
    const s = new Set(selected);
    const order = rows
      .filter((r) => r.kind === 'ticket')
      .map((r) => (r as { t: BoardTicket }).t.id);
    if (e.shiftKey && anchor) {
      const i = order.indexOf(anchor);
      const j = order.indexOf(id);
      for (const x of order.slice(Math.min(i, j), Math.max(i, j) + 1)) s.add(x);
    } else if (s.has(id)) s.delete(id);
    else s.add(id);
    anchor = id;
    selected = s;
  }

  // ── editing ──
  let editing = $state<{ id: string; field: string } | null>(null);
  function canEditCell(t: BoardTicket, field: string): boolean {
    if (t.state !== 'active') return false;
    if (field === 'stage')
      return bs.canEdit || board.stages.some((s) => s.id !== t.stageId && bs.canMoveTo(t, s.id));
    if (!bs.canEdit) return false;
    if (field === 'key' || field === 'title') return field === 'title';
    return fieldInfo(board, field)?.editable ?? false;
  }
  function startEdit(t: BoardTicket, field: string) {
    if (canEditCell(t, field)) editing = { id: t.id, field };
  }

  // ── column layout (saved in the view) ──
  function setCols(next: Col[]) {
    onchange({ ...view, columns: next });
  }
  function colMenu(c: Col, i: number): MenuItem[] {
    const sortable = fieldInfo(board, c.field)?.sortable ?? c.field === 'key';
    return [
      ...(sortable
        ? [
            {
              label: 'Sort ascending',
              icon: ArrowUp,
              onSelect: () =>
                onchange({ ...view, sort: [{ field: c.field, dir: 'asc' as const }] }),
            },
            {
              label: 'Sort descending',
              icon: ArrowDown,
              onSelect: () =>
                onchange({ ...view, sort: [{ field: c.field, dir: 'desc' as const }] }),
            },
          ]
        : []),
      {
        label: 'Move left',
        icon: ArrowLeft,
        disabled: i === 0,
        separator: sortable,
        onSelect: () => move(c, -1),
      },
      {
        label: 'Move right',
        icon: ArrowRight,
        disabled: i === cols.length - 1,
        onSelect: () => move(c, 1),
      },
      ...(c.field === 'title'
        ? []
        : [
            {
              label: 'Hide column',
              icon: EyeOff,
              onSelect: () =>
                setCols(allCols.map((x) => (x.field === c.field ? { ...x, hidden: true } : x))),
            },
          ]),
    ];
  }
  function move(c: Col, d: -1 | 1) {
    const vis = cols.map((x) => x.field);
    const i = vis.indexOf(c.field);
    const j = i + d;
    if (j < 0 || j >= vis.length) return;
    [vis[i], vis[j]] = [vis[j]!, vis[i]!];
    const byField = new Map(allCols.map((x) => [x.field, x]));
    setCols([...vis.map((f) => byField.get(f)!), ...allCols.filter((x) => x.hidden)]);
  }
  const addable = $derived(
    boardFields(board).filter((f) => f.column && !cols.some((c) => c.field === f.key)),
  );
  const addItems = $derived<MenuItem[]>([
    // A hidden Chat / Activity column comes back where it was.
    ...Object.entries(EXTRA)
      .filter(([field]) => !cols.some((c) => c.field === field))
      .map(([field, x]) => ({
        label: x.label,
        onSelect: () =>
          setCols(allCols.map((c) => (c.field === field ? { field: c.field, width: c.width } : c))),
      })),
    ...addable.map((f) => ({
      label: f.label,
      onSelect: () => {
        const exists = allCols.some((x) => x.field === f.key);
        setCols(
          exists
            ? allCols.map((x) => (x.field === f.key ? { field: x.field, width: x.width } : x))
            : [...allCols, { field: f.key, width: 140 }],
        );
      },
    })),
  ]);

  // Resize: drag the header's right edge; commit the width on release.
  let resizing = $state<{ field: string; startX: number; startW: number; w: number } | null>(null);
  function startResize(e: PointerEvent, c: Col) {
    e.preventDefault();
    e.stopPropagation();
    resizing = { field: c.field, startX: e.clientX, startW: c.width, w: c.width };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResize(e: PointerEvent) {
    if (resizing)
      resizing = {
        ...resizing,
        w: Math.max(60, Math.min(800, resizing.startW + e.clientX - resizing.startX)),
      };
  }
  function endResize() {
    if (!resizing) return;
    const r = resizing;
    resizing = null;
    if (r.w !== r.startW)
      setCols(allCols.map((x) => (x.field === r.field ? { ...x, width: Math.round(r.w) } : x)));
  }
  const widthOf = (c: Col) => (resizing?.field === c.field ? resizing.w : c.width);
  const label = (f: string) =>
    f === 'key'
      ? 'Key'
      : f === 'title'
        ? 'Title'
        : (EXTRA[f]?.label ?? fieldInfo(board, f)?.label ?? f);
  const peopleGroups = $derived(isPeopleGroup(board, view.groupBy));
</script>

<div class="flex h-full flex-col">
  <div
    bind:this={scroller}
    class="relative min-h-0 flex-1 overflow-auto"
    onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
  >
    <div role="table" aria-rowcount={rows.length} style="width:{totalWidth + 48}px">
      <!-- header -->
      <div
        role="row"
        class="sticky top-0 z-10 flex h-9 border-b border-line bg-surface text-xs font-medium text-muted"
      >
        <div
          role="columnheader"
          class="flex shrink-0 items-center justify-center"
          style="width:{SELECT_W}px"
        >
          <input
            type="checkbox"
            class="size-3.5 accent-[var(--tm-accent)]"
            checked={allOn}
            indeterminate={!allOn && selected.size > 0}
            aria-label="Select all"
            onchange={toggleAll}
          />
        </div>
        {#each cols as c, i (c.field)}
          <div
            role="columnheader"
            class="relative flex shrink-0 items-center border-l border-line"
            style="width:{widthOf(c)}px"
          >
            <Menu items={colMenu(c, i)}>
              {#snippet trigger(p)}
                <button
                  type="button"
                  {...p}
                  class="flex h-full w-full items-center gap-1 px-2 text-left hover:bg-surface-2"
                >
                  <span class="truncate">{label(c.field)}</span>
                  {#if view.sort[0]?.field === c.field}
                    {#if view.sort[0].dir === 'asc'}<ArrowUp size={11} />{:else}<ArrowDown
                        size={11}
                      />{/if}
                  {/if}
                  <ChevronDown size={11} class="ml-auto opacity-50" />
                </button>
              {/snippet}
            </Menu>
            <span
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize {label(c.field)}"
              class="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-accent/40"
              onpointerdown={(e) => startResize(e, c)}
              onpointermove={onResize}
              onpointerup={endResize}
            ></span>
          </div>
        {/each}
        {#if addItems.length}
          <div class="flex w-12 shrink-0 items-center justify-center border-l border-line">
            <Menu items={addItems} placement="bottom-end" class="max-h-80 min-w-48 overflow-auto">
              {#snippet trigger(p)}
                <button
                  type="button"
                  {...p}
                  aria-label="Add column"
                  class="grid size-6 place-items-center rounded hover:bg-surface-2"
                  ><Plus size={13} /></button
                >
              {/snippet}
            </Menu>
          </div>
        {/if}
      </div>

      <!-- body: a spacer the height of every row, with only the visible slice rendered -->
      <div role="rowgroup" class="relative" style="height:{rows.length * ROW}px">
        {#each slice as r, i (r.kind === 'group' ? `g:${r.g.key}` : `t:${r.gk}:${r.t.id}`)}
          {@const top = (first + i) * ROW}
          {#if r.kind === 'group'}
            <div
              role="row"
              class="absolute left-0 flex items-center gap-2 border-b border-line bg-surface-2 px-2 text-sm font-medium"
              style="top:{top}px;height:{ROW}px;width:{totalWidth}px"
            >
              <button
                type="button"
                class="flex items-center gap-2"
                aria-expanded={!collapsed.has(r.g.key)}
                onclick={() => {
                  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a fresh copy, assigned wholesale
                  const s = new Set(collapsed);
                  if (s.has(r.g.key)) s.delete(r.g.key);
                  else s.add(r.g.key);
                  collapsed = s;
                }}
              >
                <ChevronDown size={13} class={collapsed.has(r.g.key) ? '-rotate-90' : ''} />
                {#if peopleGroups && r.g.value != null}<PersonChip
                    uid={String(r.g.value)}
                    layout="compact"
                    size={18}
                  />
                {:else}
                  {@const st =
                    r.g.by === 'stage' && r.g.value != null ? bs.stage(r.g.key) : undefined}
                  {#if st}<Indicator of={st} seed={st.id} size="sm" />{:else if r.g.color}<span
                      class="size-2.5 rounded-full"
                      style="background:{r.g.color}"
                    ></span>{/if}
                  <span title={st?.description || undefined}>{groupLabel(board, r.g)}</span>
                {/if}
                <span class="text-xs font-normal text-subtle">{r.g.tickets.length}</span>
              </button>
            </div>
          {:else}
            {@const t = r.t}
            <div
              role="row"
              class="group absolute left-0 flex border-b border-line text-sm hover:bg-surface-2/60 {selected.has(
                t.id,
              )
                ? 'bg-accent-soft/60'
                : 'bg-surface'}"
              style="top:{top}px;height:{ROW}px;width:{totalWidth}px"
            >
              <div
                role="cell"
                class="flex shrink-0 items-center justify-center"
                style="width:{SELECT_W}px"
              >
                <input
                  type="checkbox"
                  class="size-3.5 accent-[var(--tm-accent)]"
                  checked={selected.has(t.id)}
                  aria-label="Select {t.key}"
                  onclick={(e) => toggle(t.id, e)}
                />
              </div>
              {#each cols as c (c.field)}
                {@const isEditing = editing?.id === t.id && editing.field === c.field}
                <div
                  role="cell"
                  class="flex shrink-0 items-center overflow-hidden border-l border-line/60 px-2 {isEditing
                    ? 'overflow-visible'
                    : ''}"
                  style="width:{widthOf(c)}px"
                >
                  {#if c.field === 'title' && !isEditing}
                    <button
                      type="button"
                      class="min-w-0 flex-1 truncate text-left hover:text-accent hover:underline"
                      onclick={() => bs.openTicket(t.key)}
                      ondblclick={() => startEdit(t, 'title')}
                    >
                      <TableCell
                        {board}
                        ticket={t}
                        field="title"
                        editing={false}
                        onclose={() => (editing = null)}
                      />
                    </button>
                  {:else if isEditing}
                    <TableCell
                      {board}
                      ticket={t}
                      field={c.field}
                      editing
                      onclose={() => (editing = null)}
                    />
                  {:else}
                    {#if canEditCell(t, c.field)}
                      <div
                        class="flex h-full min-w-0 flex-1 cursor-pointer items-center"
                        role="button"
                        tabindex="0"
                        onclick={() => startEdit(t, c.field)}
                        onkeydown={(e) =>
                          (e.key === 'Enter' || e.key === ' ') && startEdit(t, c.field)}
                      >
                        <TableCell
                          {board}
                          ticket={t}
                          field={c.field}
                          editing={false}
                          onclose={() => (editing = null)}
                        />
                      </div>
                    {:else}
                      <div class="flex h-full min-w-0 flex-1 items-center">
                        <TableCell
                          {board}
                          ticket={t}
                          field={c.field}
                          editing={false}
                          onclose={() => (editing = null)}
                        />
                      </div>
                    {/if}
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        {/each}
      </div>
      {#if rows.length === 0}
        <p class="p-6 text-sm text-muted">No tickets match this view.</p>
      {/if}
    </div>
  </div>
  {#if selected.size > 0}
    <BulkBar {board} ids={[...selected]} onclear={() => (selected = new Set())} />
  {/if}
</div>

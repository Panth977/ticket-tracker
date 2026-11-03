<!--
  Table (docs/plan/board-script.html §table): the columns and cells are the
  board script's previewTicketTable — a cell is text, a static h.* tree, or a
  ui.* control (edited in place, through onFieldChange). Virtualised rows (only
  what is on screen is in the DOM); grouping and sort come from the view;
  column widths can be dragged (this screen only). Selecting rows shows the
  bulk bar.
-->
<script lang="ts">
  import { ChevronDown } from 'lucide-svelte';
  import type { ScriptColumn, TicketPatch, ViewInput } from '@tm/shared';
  import { ALL_KEY, type ViewGroup } from '@tm/shared/logic/view';
  import PersonChip from '$lib/ui/PersonChip.svelte';
  import Indicator from '$lib/ui/Indicator.svelte';
  import { toast } from '$lib/ui';
  import { groupLabel, isPeopleGroup } from '$lib/views/format';
  import ScriptTableCell from '$lib/templates/ScriptTableCell.svelte';
  import type { ScriptTable } from '$lib/templates/script';
  import BulkBar from './BulkBar.svelte';
  import { useBoard, type BoardDoc, type BoardTicket } from './context.svelte';
  import { updateTicket } from './ops';

  interface Props {
    /** The loaded board (§Q4) — never null. */
    board: BoardDoc;
    groups: ViewGroup<BoardTicket>[];
    view: ViewInput;
    /** The board script's table; null while it runs, or when the script draws none. */
    table: ScriptTable | null;
  }
  let { board, groups, view, table }: Props = $props();
  const bs = useBoard();

  const ROW = 36;
  const OVERSCAN = 8;
  const SELECT_W = 36;

  /** With no previewTicketTable: key and title. */
  const FALLBACK: ScriptColumn[] = [
    { id: 'key', label: 'Key', width: 96 },
    { id: 'title', label: 'Title', width: 420, open: true },
  ];
  const cols = $derived(table?.columns ?? FALLBACK);
  let widths = $state<Record<string, number>>({});
  const widthOf = (c: ScriptColumn) => widths[c.id] ?? c.width ?? 160;
  const totalWidth = $derived(SELECT_W + cols.reduce((n, c) => n + widthOf(c), 0));

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

  // ── a control in a cell changed: onFieldChange decides the patch ──
  async function edit(t: BoardTicket, c: { id: string; value: unknown; allDay?: boolean }) {
    const h = bs.script;
    if (!h) return;
    const r = await h.change({ ticket: t, ...c });
    if (r.error !== undefined) {
      toast.error(`Board script: ${r.error}${r.line ? ` (line ${r.line})` : ''}`);
      return;
    }
    if (r.value) void updateTicket(bs, t, r.value as TicketPatch);
  }
  const cellOf = (t: BoardTicket, c: ScriptColumn) =>
    table?.rows.get(t.id)?.[c.id] ??
    (c.id === 'key'
      ? { kind: 'text' as const, text: t.key }
      : c.id === 'title'
        ? { kind: 'text' as const, text: t.title }
        : { kind: 'text' as const, text: '' });

  // Resize: drag the header's right edge (this screen only).
  let resizing = $state<{ id: string; startX: number; startW: number } | null>(null);
  function startResize(e: PointerEvent, c: ScriptColumn) {
    e.preventDefault();
    resizing = { id: c.id, startX: e.clientX, startW: widthOf(c) };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResize(e: PointerEvent) {
    if (resizing)
      widths = {
        ...widths,
        [resizing.id]: Math.max(48, Math.min(1200, resizing.startW + e.clientX - resizing.startX)),
      };
  }
  const peopleGroups = $derived(isPeopleGroup(board, view.groupBy));
</script>

<div class="flex h-full flex-col">
  <div
    bind:this={scroller}
    class="relative min-h-0 flex-1 overflow-auto"
    onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
  >
    <div role="table" aria-rowcount={rows.length} style="width:{totalWidth + 16}px">
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
        {#each cols as c (c.id)}
          <div
            role="columnheader"
            class="relative flex shrink-0 items-center border-l border-line px-2 {c.align ===
            'right'
              ? 'justify-end'
              : c.align === 'center'
                ? 'justify-center'
                : ''}"
            style="width:{widthOf(c)}px"
          >
            <span class="truncate">{c.label}</span>
            <span
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize {c.label}"
              class="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-accent/40"
              onpointerdown={(e) => startResize(e, c)}
              onpointermove={onResize}
              onpointerup={() => (resizing = null)}
            ></span>
          </div>
        {/each}
      </div>

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
              data-ticket-row={t.key}
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
              {#each cols as c (c.id)}
                <div
                  role="cell"
                  data-col={c.id}
                  class="flex shrink-0 items-center overflow-hidden border-l border-line/60 px-2 {c.align ===
                  'right'
                    ? 'justify-end'
                    : c.align === 'center'
                      ? 'justify-center'
                      : ''}"
                  style="width:{widthOf(c)}px"
                >
                  <ScriptTableCell
                    cell={cellOf(t, c)}
                    open={c.open ? () => bs.openTicket(t.key) : undefined}
                    disabled={!bs.canEdit || t.state !== 'active'}
                    people={bs.peopleChoices.map((p) => ({ id: p.id, uid: p.id, name: p.label }))}
                    tz={bs.tz}
                    onchange={(x) => void edit(t, x)}
                  />
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

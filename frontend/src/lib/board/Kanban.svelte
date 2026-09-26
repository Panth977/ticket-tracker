<!--
  Kanban (app.json components › Kanban): columns = groupBy (stage by default,
  or any select / person field); optional swimlanes = subGroupBy; a drag writes
  ONE ticketUpdate on ONE document — the grouping value(s) plus, when the view
  is in manual order, the drop position ({ after, before } neighbours → the
  server computes the fractional rank; we overlay a local one meanwhile).

  WIP: a stage column shows count / wipLimit and turns amber above it.
  A stage whose `requires` fields are missing answers 422 → the requires prompt.

  Motion (agents.html § K): new cards fade + scale in, removed ones collapse,
  cards lift on hover, the dragged one is raised. A ticket still being
  created is dimmed with a spinner (not draggable); a failed create has a red
  edge and opens the prefilled form when clicked.
-->
<script lang="ts">
  import { dndzone, TRIGGERS, type DndEvent } from 'svelte-dnd-action';
  import { flip } from 'svelte/animate';
  import { ChevronDown, ChevronRight, Loader2, Plus } from 'lucide-svelte';
  import { outbox } from '$lib/api';
  import { collapse } from '$lib/ui/motion';
  import type { ViewInput } from '@tm/shared';
  import type { ViewGroup } from '@tm/shared/logic/view';
  import PersonChip from '$lib/ui/PersonChip.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import { groupLabel, isPeopleGroup } from '$lib/views/format';
  import { dropPosition, mergePatches, movePatch } from '$lib/views/move';
  import TicketCard from './TicketCard.svelte';
  import { useBoard, type BoardDoc, type BoardTicket } from './context.svelte';
  import { updateTicket } from './ops';

  interface Props {
    /** The loaded board (§Q4) — never null: the route holds its skeleton until it is here. */
    board: BoardDoc;
    groups: ViewGroup<BoardTicket>[];
    view: ViewInput;
    /** '+' at the foot of a column: create a ticket already in that column (and lane). */
    onadd?: (col: ViewGroup<BoardTicket>, lane: ViewGroup<BoardTicket> | null) => void;
  }
  let { board, groups, view, onadd }: Props = $props();
  const bs = useBoard();

  type Item = { id: string; t: BoardTicket };
  const FLIP = 150;
  // Manual order = the board's own rank order: no sort, or exactly 'rank asc'
  // (what the templates' default Board view saves). Anything else re-sorts, so a
  // drop position would be meaningless. (integration fix: default views sort by rank)
  const manualOrder = $derived(
    view.sort.length === 0 ||
      (view.sort.length === 1 && view.sort[0]!.field === 'rank' && view.sort[0]!.dir === 'asc'),
  );
  const lanes = $derived(view.subGroupBy ? (groups[0]?.subGroups ?? []) : null);

  /** zone key → the items drawn in it (a local copy dnd can reorder while dragging). */
  let zones = $state<Record<string, Item[]>>({});
  let dragging = $state(false);
  /** Where the dragged card came from: its column and lane keys. */
  let origin: { id: string; col: string; lane: string | null } | null = null;
  let collapsed = $state<Set<string>>(new Set());

  const zoneKey = (col: string, lane: string | null) => `${col}|${lane ?? ''}`;

  // Rebuild the zones from the live groups — but never mid-drag (it would yank the card away).
  $effect(() => {
    void rebuild;
    const next: Record<string, Item[]> = {};
    for (const g of groups) {
      if (g.subGroups)
        for (const l of g.subGroups)
          next[zoneKey(g.key, l.key)] = l.tickets.map((t) => ({ id: t.id, t }));
      else next[zoneKey(g.key, null)] = g.tickets.map((t) => ({ id: t.id, t }));
    }
    if (!dragging) zones = next;
  });

  /** Editors drag anything; a commenter with a StageGrant may drag between stage columns only. */
  const dragDisabled = $derived(
    !bs.canEdit &&
      !(
        view.groupBy === 'stage' &&
        bs.role === 'commenter' &&
        !!board.stageGrants[bs.me]?.stages.length
      ),
  );
  /** Bumped to force the zones back to the live groups (a refused drop). */
  let rebuild = $state(0);

  function consider(key: string, col: string, lane: string | null, e: CustomEvent<DndEvent<Item>>) {
    if (e.detail.info.trigger === TRIGGERS.DRAG_STARTED) {
      dragging = true;
      origin = { id: e.detail.info.id, col, lane };
    }
    zones[key] = e.detail.items;
  }

  async function finalize(
    key: string,
    col: string,
    lane: string | null,
    e: CustomEvent<DndEvent<Item>>,
  ) {
    zones[key] = e.detail.items;
    const { trigger, id } = e.detail.info;
    if (trigger !== TRIGGERS.DROPPED_INTO_ZONE) {
      if (trigger === TRIGGERS.DROPPED_OUTSIDE_OF_ANY || trigger === TRIGGERS.DRAG_STOPPED)
        dragging = false;
      return;
    }
    dragging = false;
    const from = origin;
    origin = null;
    const item = e.detail.items.find((i) => i.id === id);
    if (!from || !item) return;
    // Not created yet: nothing to move.
    if (bs.pending.has(id)) {
      zonesFromGroups();
      return;
    }
    const t = item.t;

    const colPatch = movePatch(view.groupBy, from.col, col, t, board);
    const lanePatch =
      view.subGroupBy && lane != null && from.lane != null
        ? movePatch(view.subGroupBy, from.lane, lane, t, board)
        : null;
    const patch = mergePatches(colPatch, lanePatch) ?? {};
    const pos = manualOrder
      ? dropPosition(
          e.detail.items.map((i) => i.t),
          id,
        )
      : null;
    const moved = Object.keys(patch).length > 0;
    if (!moved) {
      // Nothing but (maybe) the order changed: skip when unordered or dropped where it was.
      if (!pos) return;
      if (from.col === col && from.lane === lane && pos.after === prevOf(from, id)) return;
    }

    // Permission, before the round-trip: a commenter only moves between stages of their grant.
    const toStage = patch.stageId ?? t.stageId;
    const onlyStage = Object.keys(patch).every((k) => k === 'stageId');
    if (!bs.canEdit && !(onlyStage && bs.can('move', t, toStage))) {
      toast.error("You can't move this ticket there", 'Your role on this board does not allow it.');
      zonesFromGroups();
      return;
    }
    await updateTicket(
      bs,
      t,
      patch,
      pos ? { rank: { after: pos.after, before: pos.before }, localRank: pos.rank } : {},
    );
  }

  /** The id above `id` in its original column (to detect a no-op drop). */
  function prevOf(from: { col: string; lane: string | null }, id: string): string | undefined {
    const g = groups.find((x) => x.key === from.col);
    const list =
      from.lane != null ? g?.subGroups?.find((l) => l.key === from.lane)?.tickets : g?.tickets;
    const i = list?.findIndex((t) => t.id === id) ?? -1;
    return i > 0 ? list![i - 1]!.id : undefined;
  }
  function zonesFromGroups() {
    dragging = false;
    rebuild++;
  }

  function toggleLane(k: string) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a fresh copy, assigned wholesale
    const s = new Set(collapsed);
    if (s.has(k)) s.delete(k);
    else s.add(k);
    collapsed = s;
  }

  const wip = (g: ViewGroup<BoardTicket>) =>
    view.groupBy === 'stage' ? bs.stage(g.key)?.wipLimit : undefined;
  const peopleCols = $derived(isPeopleGroup(board, view.groupBy));
  const peopleLanes = $derived(isPeopleGroup(board, view.subGroupBy));
</script>

{#snippet heading(g: ViewGroup<BoardTicket>, people: boolean)}
  {#if people && g.value != null}
    <PersonChip
      uid={String(g.value)}
      layout="compact"
      size={18}
      suffix={g.value === bs.me ? '(you)' : undefined}
    />
  {:else}
    {#if g.color}<span class="size-2.5 shrink-0 rounded-full" style="background:{g.color}"
      ></span>{/if}
    <span class="truncate">{groupLabel(board, g)}</span>
  {/if}
{/snippet}

{#snippet zone(col: ViewGroup<BoardTicket>, lane: ViewGroup<BoardTicket> | null)}
  {@const key = zoneKey(col.key, lane?.key ?? null)}
  <div
    class="flex min-h-16 flex-col gap-1.5 rounded-md p-1"
    aria-label="{groupLabel(board, col)}{lane ? ` · ${groupLabel(board, lane)}` : ''}"
    use:dndzone={{
      items: zones[key] ?? [],
      flipDurationMs: FLIP,
      type: 'ticket',
      dragDisabled,
      dropTargetStyle: { outline: '2px dashed var(--tm-accent)', outlineOffset: '-2px' },
      delayTouchStart: true,
    }}
    onconsider={(e) => consider(key, col.key, lane?.key ?? null, e)}
    onfinalize={(e) => finalize(key, col.key, lane?.key ?? null, e)}
  >
    {#each zones[key] ?? [] as item (item.id)}
      {@const pend = bs.pending.get(item.id)}
      <div animate:flip={{ duration: FLIP }} out:collapse={{ duration: dragging ? 0 : 160 }}>
        <!-- A div, not a button: the card holds its own 'copy key' button. dnd makes it focusable. -->
        <div
          role="button"
          tabindex="0"
          aria-label="{item.t.key} {item.t.title}{pend
            ? pend.state === 'failed'
              ? ' — could not be created'
              : ' — being created'
            : ''}"
          aria-busy={pend?.state === 'sending' || undefined}
          class="tm-card tm-pop relative w-full cursor-pointer rounded-md border bg-surface p-2 text-left shadow-sm hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent
            {pend?.state === 'failed'
            ? 'border-danger/60 border-l-4 border-l-danger'
            : 'border-line'} {pend?.state === 'sending' ? 'opacity-60' : ''}"
          title={pend?.state === 'failed'
            ? 'Could not create this ticket — click to open the form again'
            : undefined}
          onclick={() =>
            pend ? pend.state === 'failed' && outbox.open(pend.entryId) : bs.openTicket(item.t.key)}
          onkeydown={(e) => {
            if (pend) return;
            if (e.key === 'o' || (e.key === 'Enter' && dragDisabled)) bs.openTicket(item.t.key);
          }}
        >
          {#if pend?.state === 'sending'}
            <Loader2
              size={13}
              class="absolute top-2 right-2 animate-spin text-muted"
              aria-hidden="true"
            />
          {/if}
          <TicketCard {board} ticket={item.t} cardFields={view.cardFields} />
        </div>
      </div>
    {/each}
  </div>
  {#if onadd && bs.canCreate}
    <button
      type="button"
      class="flex items-center gap-1 rounded px-2 py-1 text-xs text-subtle hover:bg-surface-2 hover:text-text"
      onclick={() => onadd(col, lane)}><Plus size={12} /> New</button
    >
  {/if}
{/snippet}

<div class="h-full snap-x snap-mandatory overflow-auto sm:snap-none">
  {#if !lanes}
    <div class="flex h-full min-w-max items-start gap-3 p-4">
      {#each groups as g (g.key)}
        {@const limit = wip(g)}
        {@const over = limit != null && g.tickets.length > limit}
        <section
          class="flex max-h-full w-[calc(100vw-2rem)] shrink-0 snap-start flex-col rounded-lg bg-surface-2/60 sm:w-72"
          aria-label={groupLabel(board, g)}
        >
          <header class="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5 text-sm font-medium">
            {@render heading(g, peopleCols)}
            <span
              class="ml-auto text-xs font-normal {over
                ? 'rounded bg-warning-soft px-1.5 font-semibold text-warning'
                : 'text-subtle'}"
              title={limit != null ? `WIP limit ${limit}` : undefined}
            >
              {g.tickets.length}{#if limit != null}
                / {limit}{/if}
            </span>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {@render zone(g, null)}
          </div>
        </section>
      {/each}
    </div>
  {:else}
    <div class="min-w-max p-4">
      <div class="sticky top-0 z-10 flex gap-3 bg-bg pb-2 pl-6">
        {#each groups as g (g.key)}
          {@const limit = wip(g)}
          <div class="flex w-72 shrink-0 items-center gap-1.5 px-2 text-sm font-medium">
            {@render heading(g, peopleCols)}
            <span
              class="ml-auto text-xs {limit != null && g.tickets.length > limit
                ? 'font-semibold text-warning'
                : 'text-subtle'}"
            >
              {g.tickets.length}{#if limit != null}
                / {limit}{/if}
            </span>
          </div>
        {/each}
      </div>
      {#each lanes as lane (lane.key)}
        {@const open = !collapsed.has(lane.key)}
        {@const total = groups.reduce(
          (n, g) => n + (g.subGroups?.find((l) => l.key === lane.key)?.tickets.length ?? 0),
          0,
        )}
        <section class="mb-3 border-t border-line pt-2" aria-label={groupLabel(board, lane)}>
          <button
            type="button"
            class="mb-1.5 flex items-center gap-1.5 text-sm font-medium"
            onclick={() => toggleLane(lane.key)}
            aria-expanded={open}
          >
            {#if open}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}
            {@render heading(lane, peopleLanes)}
            <span class="text-xs font-normal text-subtle">{total}</span>
          </button>
          {#if open}
            <div class="flex gap-3 pl-6">
              {#each groups as g (g.key)}
                {@const cell = g.subGroups?.find((l) => l.key === lane.key) ?? lane}
                <div class="w-72 shrink-0 rounded-lg bg-surface-2/60 p-1">
                  {@render zone(g, cell)}
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</div>

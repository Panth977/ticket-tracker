<!--
  Calendar (app.json components › Calendar):
    Mon Tue Wed Thu Fri Sat Sun      | Unscheduled
    [chips on the day of the view's dateField]   | [chips with no date]
  Drag a chip to another day → one ticketUpdate shifting that date by whole
  days (a timed due date keeps its time). Drag from the tray onto a day to
  schedule it (all-day); drop a chip on the tray to clear its date.
  Native HTML5 drag & drop: 42 day cells as drop targets, no reordering.
-->
<script lang="ts">
  import { ChevronLeft, ChevronRight, Inbox } from 'lucide-svelte';
  import type { Millis, ViewInput } from '@tm/shared';
  import type { ViewGroup } from '@tm/shared/logic/view';
  import { zonedParts, zonedTimeToMillis } from '@tm/shared/logic/time';
  import Button from '$lib/ui/Button.svelte';
  import { addMonths, monthGrid } from '$lib/ui/calendar';
  import { toast } from '$lib/ui/toast.svelte';
  import { boardFields } from '$lib/views/fields';
  import { clearDatePatch, dateOf, dayStart, setDatePatch } from '$lib/views/dates';
  import TicketCard from './TicketCard.svelte';
  import { useBoard, type BoardDoc, type BoardTicket } from './context.svelte';
  import { updateTicket } from './ops';

  interface Props {
    /** The loaded board (§Q4) — never null. */
    board: BoardDoc;
    groups: ViewGroup<BoardTicket>[];
    view: ViewInput;
    onchange: (view: ViewInput) => void;
  }
  let { board, groups, view, onchange }: Props = $props();
  const bs = useBoard();
  const tz = $derived(bs.tz);
  const weekStartsOn = $derived(bs.viewCtx.weekStartsOn ?? 1);
  const dateKey = $derived(view.dateField ?? 'due');
  const dateFields = $derived(boardFields(board).filter((f) => f.dateLike));

  // Month on screen (wall-clock year/month in my zone).
  const today = $derived(zonedParts(bs.now, tz));
  let ym = $state<{ year: number; month: number } | null>(null);
  const cur = $derived(ym ?? { year: today.year, month: today.month });
  const cells = $derived(
    monthGrid(cur.year, cur.month, weekStartsOn).map((d) => ({
      ...d,
      start: zonedTimeToMillis(d.year, d.month, d.day, 0, 0, tz),
      isToday: d.year === today.year && d.month === today.month && d.day === today.day,
    })),
  );
  const weekdays = $derived(
    Array.from({ length: 7 }, (_, i) =>
      new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2024, 0, 7 + ((weekStartsOn + i) % 7))),
      ),
    ),
  );
  const title = $derived(
    new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(Date.UTC(cur.year, cur.month - 1, 1)),
    ),
  );

  const tickets = $derived(groups.flatMap((g) => g.tickets));
  /** dayStart → tickets on that day, in view order. */
  const byDay = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- built fresh by the derived, never mutated after
    const m = new Map<Millis, BoardTicket[]>();
    for (const t of tickets) {
      const d = dateOf(t, dateKey, board);
      if (d == null) continue;
      const k = dayStart(d, tz);
      const list = m.get(k);
      if (list) list.push(t);
      else m.set(k, [t]);
    }
    return m;
  });
  const unscheduled = $derived(tickets.filter((t) => dateOf(t, dateKey, board) == null));

  const MAX_CHIPS = 4;
  let expanded = $state<Set<Millis>>(new Set());

  // ── drag & drop ──
  let dragId: string | null = null;
  let over = $state<Millis | 'tray' | null>(null);
  const editable = (t: BoardTicket) => bs.canEdit && t.state === 'active';

  function dragStart(e: DragEvent, t: BoardTicket) {
    if (!editable(t)) {
      e.preventDefault();
      return;
    }
    dragId = t.id;
    e.dataTransfer?.setData('text/plain', t.key);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }
  function dragOver(e: DragEvent, target: Millis | 'tray') {
    if (!dragId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    over = target;
  }
  async function drop(e: DragEvent, target: Millis | 'tray') {
    e.preventDefault();
    over = null;
    const t = dragId ? bs.byId.get(dragId) : undefined;
    dragId = null;
    if (!t) return;
    const cur = dateOf(t, dateKey, board);
    if (target === 'tray') {
      if (cur == null) return;
      const p = clearDatePatch(dateKey, board);
      if (p) await updateTicket(bs, t, p, { failure: `Could not unschedule ${t.key}` });
      return;
    }
    if (cur != null && dayStart(cur, tz) === target) return;
    const p = setDatePatch(t, dateKey, board, target, tz);
    if (!p) {
      toast.error("This date can't be changed by dragging");
      return;
    }
    await updateTicket(bs, t, p, { failure: `Could not reschedule ${t.key}` });
  }
  function dragEnd() {
    dragId = null;
    over = null;
  }

  function shift(n: number) {
    ym = addMonths(cur.year, cur.month, n);
  }
</script>

{#snippet chip(t: BoardTicket)}
  <div
    role="button"
    tabindex="0"
    draggable={editable(t)}
    class="w-full cursor-pointer rounded border border-line bg-surface px-1.5 py-0.5 text-left shadow-xs hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent"
    aria-label="{t.key} {t.title}"
    ondragstart={(e) => dragStart(e, t)}
    ondragend={dragEnd}
    onclick={() => bs.openTicket(t.key)}
    onkeydown={(e) => (e.key === 'Enter' || e.key === 'o') && bs.openTicket(t.key)}
  >
    <TicketCard {board} ticket={t} cardFields={view.cardFields} compact />
  </div>
{/snippet}

<div class="flex h-full min-h-0">
  <div class="flex min-w-0 flex-1 flex-col">
    <div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
      <Button size="sm" variant="ghost" onclick={() => (ym = null)}>Today</Button>
      <button
        type="button"
        class="grid size-7 place-items-center rounded hover:bg-surface-2"
        aria-label="Previous month"
        onclick={() => shift(-1)}
      >
        <ChevronLeft size={15} />
      </button>
      <button
        type="button"
        class="grid size-7 place-items-center rounded hover:bg-surface-2"
        aria-label="Next month"
        onclick={() => shift(1)}
      >
        <ChevronRight size={15} />
      </button>
      <h2 class="text-sm font-semibold">{title}</h2>
      <label class="ml-auto flex items-center gap-1.5 text-xs text-muted">
        Date
        <select
          class="h-7 rounded-md border border-line bg-surface px-1.5 text-sm text-text"
          value={dateKey}
          onchange={(e) => onchange({ ...view, dateField: e.currentTarget.value })}
        >
          {#each dateFields as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
        </select>
      </label>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <div
        class="grid min-w-[42rem] grid-cols-7 border-l border-line"
        role="grid"
        aria-label={title}
      >
        {#each weekdays as w (w)}
          <div
            role="columnheader"
            class="sticky top-0 z-10 border-r border-b border-line bg-surface px-2 py-1 text-xs font-medium text-muted"
          >
            {w}
          </div>
        {/each}
        {#each cells as c (c.start)}
          {@const list = byDay.get(c.start) ?? []}
          {@const open = expanded.has(c.start)}
          <div
            role="gridcell"
            tabindex="-1"
            aria-label="{c.year}-{c.month}-{c.day}, {list.length} tickets"
            class="flex min-h-28 flex-col gap-1 border-r border-b border-line p-1 {c.inMonth
              ? 'bg-bg'
              : 'bg-surface-2/50'} {over === c.start
              ? 'outline-2 -outline-offset-2 outline-accent outline-dashed'
              : ''}"
            ondragover={(e) => dragOver(e, c.start)}
            ondragleave={() => over === c.start && (over = null)}
            ondrop={(e) => drop(e, c.start)}
          >
            <span
              class="self-end px-1 text-xs {c.isToday
                ? 'rounded-full bg-accent font-semibold text-white'
                : c.inMonth
                  ? 'text-muted'
                  : 'text-subtle'}">{c.day}</span
            >
            {#each open ? list : list.slice(0, MAX_CHIPS) as t (t.id)}
              {@render chip(t)}
            {/each}
            {#if list.length > MAX_CHIPS}
              <button
                type="button"
                class="self-start px-1 text-[11px] text-muted hover:text-text"
                onclick={() => {
                  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a fresh copy, assigned wholesale
                  const s = new Set(expanded);
                  if (open) s.delete(c.start);
                  else s.add(c.start);
                  expanded = s;
                }}>{open ? 'Show less' : `+${list.length - MAX_CHIPS} more`}</button
              >
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>

  <aside
    class="hidden w-64 shrink-0 flex-col border-l border-line bg-surface md:flex {over === 'tray'
      ? 'outline-2 -outline-offset-2 outline-accent outline-dashed'
      : ''}"
    aria-label="Unscheduled tickets"
    ondragover={(e) => dragOver(e, 'tray')}
    ondragleave={() => over === 'tray' && (over = null)}
    ondrop={(e) => drop(e, 'tray')}
  >
    <h3 class="flex items-center gap-1.5 border-b border-line px-3 py-2.5 text-sm font-medium">
      <Inbox size={14} /> Unscheduled
      <span class="ml-auto text-xs font-normal text-subtle">{unscheduled.length}</span>
    </h3>
    <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
      {#each unscheduled as t (t.id)}
        {@render chip(t)}
      {:else}
        <p class="p-2 text-xs text-muted">
          Everything in this view has a date. Drop a ticket here to clear its date.
        </p>
      {/each}
    </div>
  </aside>
</div>

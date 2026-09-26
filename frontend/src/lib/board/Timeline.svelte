<!--
  Timeline (app.json components › Timeline):
    ENG-40  ▇▇▇▇▇▇
    ENG-41      ▇▇▇▇▇▇▇▇▇
    ENG-42   ▇▇▇ → blocked by 41
  A real bar from the view's dateField (default start) to endDateField
  (default due); a ticket with only one of them is a one-day bar. Drag the bar
  to shift it, drag either end to stretch it — whole days in my zone, one
  ticketUpdate on release. 'blocks' links are drawn as arrows from the end of
  the blocker to the start of what it blocks. Undated tickets sit below; a
  double-click on their track schedules them on that day.
-->
<script lang="ts">
  import { ChevronLeft, ChevronRight } from 'lucide-svelte';
  import type { Millis, ViewInput } from '@tm/shared';
  import type { ViewGroup } from '@tm/shared/logic/view';
  import { addDaysTz, zonedParts } from '@tm/shared/logic/time';
  import Button from '$lib/ui/Button.svelte';
  import { boardFields } from '$lib/views/fields';
  import { barOf, dayDiff, dayStart, setDatePatch, shiftBarPatch } from '$lib/views/dates';
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
  const startKey = $derived(view.dateField ?? 'start');
  const endKey = $derived(view.endDateField ?? 'due');
  const dateFields = $derived(boardFields(board).filter((f) => f.dateLike));

  const ROW = 32;
  const LEFT = 260;
  const HEAD = 44;
  const ZOOM = { week: { dayW: 30, days: 91 }, month: { dayW: 10, days: 273 } } as const;
  let zoom = $state<keyof typeof ZOOM>('week');
  const dayW = $derived(ZOOM[zoom].dayW);
  const span = $derived(ZOOM[zoom].days);

  /** First day on screen; null = two weeks before today, on a week boundary. */
  let origin = $state<Millis | null>(null);
  const from = $derived.by(() => {
    if (origin != null) return origin;
    const back = (zonedParts(bs.now, tz).weekday - (bs.viewCtx.weekStartsOn ?? 1) + 7) % 7;
    return dayStart(bs.now, tz, -14 - back);
  });
  const days = $derived(Array.from({ length: span }, (_, i) => addDaysTz(from, i, tz)));
  const width = $derived(span * dayW);
  const todayX = $derived(dayDiff(from, bs.now, tz) * dayW);

  const tickets = $derived(groups.flatMap((g) => g.tickets));
  const rows = $derived(tickets.map((t) => ({ t, bar: barOf(t, startKey, endKey, board, tz) })));
  const dated = $derived(rows.filter((r) => r.bar));
  const undated = $derived(rows.filter((r) => !r.bar));
  const ordered = $derived([...dated, ...undated]);
  const rowOf = $derived(new Map(ordered.map((r, i) => [r.t.id, i])));

  // ── header: months (and day numbers when zoomed in) ──
  const months = $derived.by(() => {
    const out: { x: number; w: number; label: string }[] = [];
    days.forEach((d, i) => {
      const p = zonedParts(d, tz);
      if (i === 0 || p.day === 1) {
        const label = new Intl.DateTimeFormat(undefined, {
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(new Date(Date.UTC(p.year, p.month - 1, 1)));
        out.push({ x: i * dayW, w: 0, label });
      }
    });
    out.forEach((m, i) => (m.w = (out[i + 1]?.x ?? width) - m.x));
    return out;
  });
  const dayCells = $derived(days.map((d, i) => ({ i, p: zonedParts(d, tz) })));

  // ── drag ──
  type Drag = {
    id: string;
    edge: 'start' | 'end' | 'both';
    x0: number;
    delta: number;
    moved: boolean;
  };
  let drag = $state<Drag | null>(null);
  const editable = (t: BoardTicket) => bs.canEdit && t.state === 'active';

  function geom(bar: { start: Millis; end: Millis }, id: string) {
    let s = dayDiff(from, bar.start, tz);
    let e = dayDiff(from, bar.end, tz);
    if (drag?.id === id && drag.delta) {
      if (drag.edge !== 'end') s += drag.delta;
      if (drag.edge !== 'start') e += drag.delta;
      if (s > e) [s, e] = drag.edge === 'start' ? [e, e] : [s, s];
    }
    return { x: s * dayW, w: (e - s + 1) * dayW };
  }

  function down(e: PointerEvent, t: BoardTicket, edge: Drag['edge']) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!editable(t)) {
      if (edge === 'both') bs.openTicket(t.key);
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { id: t.id, edge, x0: e.clientX, delta: 0, moved: false };
  }
  function move(e: PointerEvent) {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    drag = { ...drag, delta: Math.round(dx / dayW), moved: drag.moved || Math.abs(dx) > 3 };
  }
  async function up(t: BoardTicket) {
    const d = drag;
    drag = null;
    if (!d) return;
    if (!d.moved) {
      if (d.edge === 'both') bs.openTicket(t.key);
      return;
    }
    const patch = shiftBarPatch(t, startKey, endKey, board, tz, d.edge, d.delta);
    if (patch) await updateTicket(bs, t, patch, { failure: `Could not reschedule ${t.key}` });
  }

  /** Double-click an undated row's track: a one-day bar on that day. */
  async function schedule(e: MouseEvent, t: BoardTicket) {
    if (!editable(t)) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const i = Math.max(0, Math.floor((e.clientX - rect.left) / dayW));
    const day = addDaysTz(from, i, tz);
    const a = setDatePatch(t, startKey, board, day, tz) ?? {};
    const b = endKey && endKey !== startKey ? (setDatePatch(t, endKey, board, day, tz) ?? {}) : {};
    const merged = {
      ...a,
      ...b,
      ...(a.fields || b.fields ? { fields: { ...a.fields, ...b.fields } } : {}),
    };
    if (Object.keys(merged).length)
      await updateTicket(bs, t, merged, { failure: `Could not schedule ${t.key}` });
  }

  // ── 'blocks' arrows ──
  const arrows = $derived.by(() => {
    const out: { key: string; d: string }[] = [];
    for (const r of dated) {
      for (const l of r.t.links) {
        if (l.type !== 'blocks') continue;
        const j = rowOf.get(l.ticketId);
        const other = j != null ? ordered[j] : undefined;
        if (!other?.bar) continue;
        const a = geom(r.bar!, r.t.id);
        const b = geom(other.bar, other.t.id);
        const x1 = a.x + a.w;
        const y1 = rowOf.get(r.t.id)! * ROW + ROW / 2;
        const x2 = b.x;
        const y2 = j! * ROW + ROW / 2;
        const mid = x2 - x1 >= 16 ? (x1 + x2) / 2 : x1 + 8;
        const d =
          x2 - x1 >= 16
            ? `M${x1},${y1} H${mid} V${y2} H${x2 - 2}`
            : `M${x1},${y1} H${mid} V${(y1 + y2) / 2} H${x2 - 8} V${y2} H${x2 - 2}`;
        out.push({ key: `${r.t.id}>${l.ticketId}`, d });
      }
    }
    return out;
  });

  function page(n: number) {
    origin = addDaysTz(from, Math.round((span / 3) * n), tz);
  }
  const barColor = (t: BoardTicket) => bs.stage(t.stageId)?.color ?? 'var(--tm-accent)';
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-sm">
    <Button size="sm" variant="ghost" onclick={() => (origin = null)}>Today</Button>
    <button
      type="button"
      class="grid size-7 place-items-center rounded hover:bg-surface-2"
      aria-label="Earlier"
      onclick={() => page(-1)}
    >
      <ChevronLeft size={15} />
    </button>
    <button
      type="button"
      class="grid size-7 place-items-center rounded hover:bg-surface-2"
      aria-label="Later"
      onclick={() => page(1)}
    >
      <ChevronRight size={15} />
    </button>
    <div class="flex rounded-md border border-line p-0.5 text-xs" role="group" aria-label="Zoom">
      {#each ['week', 'month'] as const as z (z)}
        <button
          type="button"
          class="rounded px-2 py-0.5 {zoom === z ? 'bg-surface-2 font-medium' : 'text-muted'}"
          aria-pressed={zoom === z}
          onclick={() => (zoom = z)}>{z === 'week' ? 'Weeks' : 'Months'}</button
        >
      {/each}
    </div>
    <label class="ml-auto flex items-center gap-1.5 text-xs text-muted">
      From
      <select
        class="h-7 rounded-md border border-line bg-surface px-1.5 text-sm text-text"
        value={startKey}
        onchange={(e) => onchange({ ...view, dateField: e.currentTarget.value })}
      >
        {#each dateFields as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
      </select>
      to
      <select
        class="h-7 rounded-md border border-line bg-surface px-1.5 text-sm text-text"
        value={endKey}
        onchange={(e) => onchange({ ...view, endDateField: e.currentTarget.value })}
      >
        {#each dateFields as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
      </select>
    </label>
  </div>

  <div class="relative min-h-0 flex-1 overflow-auto">
    <div
      class="relative"
      style="width:{LEFT + width}px; height:{HEAD + ordered.length * ROW + 8}px"
    >
      <!-- header -->
      <div class="sticky top-0 z-20 flex border-b border-line bg-surface" style="height:{HEAD}px">
        <div
          class="sticky left-0 z-10 flex shrink-0 items-end border-r border-line bg-surface px-3 pb-1.5 text-xs font-medium text-muted"
          style="width:{LEFT}px"
        >
          Ticket
        </div>
        <div class="relative shrink-0" style="width:{width}px">
          {#each months as m (m.x)}
            <div
              class="absolute top-0 truncate border-l border-line px-1.5 pt-1 text-xs font-medium"
              style="left:{m.x}px;width:{m.w}px"
            >
              {m.label}
            </div>
          {/each}
          {#if zoom === 'week'}
            {#each dayCells as c (c.i)}
              <div
                class="absolute bottom-0 text-center text-[10px] {c.p.weekday === 0 ||
                c.p.weekday === 6
                  ? 'text-subtle'
                  : 'text-muted'}"
                style="left:{c.i * dayW}px;width:{dayW}px"
              >
                {c.p.day}
              </div>
            {/each}
          {:else}
            {#each dayCells.filter((c) => c.p.weekday === (bs.viewCtx.weekStartsOn ?? 1)) as c (c.i)}
              <div
                class="absolute bottom-0 border-l border-line pl-0.5 text-[10px] text-muted"
                style="left:{c.i * dayW}px"
              >
                {c.p.day}
              </div>
            {/each}
          {/if}
        </div>
      </div>

      <!-- rows -->
      <div class="relative" style="height:{ordered.length * ROW}px">
        <!-- weekend shading + today line -->
        <div
          class="pointer-events-none absolute top-0 bottom-0"
          style="left:{LEFT}px;width:{width}px"
        >
          {#if zoom === 'week'}
            {#each dayCells.filter((c) => c.p.weekday === 0 || c.p.weekday === 6) as c (c.i)}
              <div
                class="absolute top-0 bottom-0 bg-surface-2/50"
                style="left:{c.i * dayW}px;width:{dayW}px"
              ></div>
            {/each}
          {/if}
          {#if todayX >= 0 && todayX <= width}
            <div
              class="absolute top-0 bottom-0 w-px bg-accent"
              style="left:{todayX + dayW / 2}px"
              aria-hidden="true"
            ></div>
          {/if}
        </div>

        {#each ordered as r, i (r.t.id)}
          {@const t = r.t}
          <div
            class="absolute left-0 flex border-b border-line/60"
            style="top:{i * ROW}px;height:{ROW}px;width:{LEFT + width}px"
          >
            <button
              type="button"
              class="sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r border-line bg-surface px-3 text-left text-sm hover:bg-surface-2"
              style="width:{LEFT}px"
              onclick={() => bs.openTicket(t.key)}
            >
              <span class="shrink-0 font-mono text-[11px] text-subtle">{t.key}</span>
              <span class="truncate {t.state !== 'active' ? 'text-muted line-through' : ''}"
                >{t.title}</span
              >
            </button>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="relative shrink-0"
              style="width:{width}px"
              ondblclick={(e) => !r.bar && schedule(e, t)}
              title={!r.bar && editable(t) ? 'Double-click to schedule' : undefined}
            >
              {#if r.bar}
                {@const g = geom(r.bar, t.id)}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  class="absolute top-1.5 flex h-5 items-center rounded text-[11px] text-white shadow-sm select-none {editable(
                    t,
                  )
                    ? 'cursor-grab'
                    : 'cursor-pointer'} {drag?.id === t.id
                    ? 'cursor-grabbing opacity-80 ring-2 ring-accent'
                    : ''}"
                  style="left:{g.x + 1}px;width:{Math.max(g.w - 2, 6)}px;background:{barColor(t)}"
                  title="{t.key} · {t.title}"
                  onpointerdown={(e) => down(e, t, 'both')}
                  onpointermove={move}
                  onpointerup={() => up(t)}
                  onpointercancel={() => (drag = null)}
                >
                  {#if editable(t)}
                    <span
                      class="absolute top-0 left-0 h-full w-1.5 cursor-ew-resize rounded-l bg-black/15"
                      aria-hidden="true"
                      onpointerdown={(e) => down(e, t, 'start')}
                      onpointermove={move}
                      onpointerup={() => up(t)}
                    ></span>
                    <span
                      class="absolute top-0 right-0 h-full w-1.5 cursor-ew-resize rounded-r bg-black/15"
                      aria-hidden="true"
                      onpointerdown={(e) => down(e, t, 'end')}
                      onpointermove={move}
                      onpointerup={() => up(t)}
                    ></span>
                  {/if}
                  {#if g.w > 60}<span class="truncate px-2">{t.title}</span>{/if}
                </div>
              {:else if i === dated.length}
                <span class="absolute top-2 left-2 text-xs text-subtle"
                  >No dates{editable(t) ? ' — double-click the track to schedule' : ''}</span
                >
              {/if}
            </div>
          </div>
        {/each}

        <svg
          class="pointer-events-none absolute top-0"
          style="left:{LEFT}px"
          {width}
          height={ordered.length * ROW}
          aria-hidden="true"
        >
          <defs>
            <marker
              id="tl-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" fill="var(--tm-danger, #dc2626)" />
            </marker>
          </defs>
          {#each arrows as a (a.key)}
            <path
              d={a.d}
              fill="none"
              stroke="var(--tm-danger, #dc2626)"
              stroke-width="1.5"
              marker-end="url(#tl-arrow)"
              opacity="0.8"
            />
          {/each}
        </svg>
      </div>
      {#if ordered.length === 0}
        <p class="p-6 text-sm text-muted">No tickets match this view.</p>
      {/if}
    </div>
  </div>
</div>

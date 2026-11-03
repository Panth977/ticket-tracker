<!--
  h.timeline (docs/plan/board-script.html §previews): the app's Gantt, drawn from
  a board script's items.

    h.timeline({ items: [{ id, title, start, end?, color?, group? }], date, days,
                 onOpen({ id }), onMove({ id, start, end }) })

  One row per item (grouped under `group` when given), a bar from start to end
  (one day when there is no end). Drag a bar to move it, drag its right edge to
  change the end: whole days, reported through onMove. A click opens.
-->
<script lang="ts" module>
  export interface TimelineItem {
    id: string;
    title: string;
    start: number;
    end?: number | null;
    color?: string | null;
    group?: string | null;
  }
</script>

<script lang="ts">
  import { ChevronLeft, ChevronRight } from 'lucide-svelte';
  import { zonedParts, zonedTimeToMillis } from '@tm/shared/logic/time';
  import Button from '$lib/ui/Button.svelte';

  interface Props {
    items?: TimelineItem[];
    date?: number | null;
    days?: number;
    tz: string;
    can: { open: boolean; move: boolean };
    send: (prop: string, args: unknown[]) => void;
  }
  let { items = [], date = null, days = 42, tz, can, send }: Props = $props();

  const DAY_W = 28;
  const LABEL_W = 220;
  const dayStartOf = (ms: number) => {
    const q = zonedParts(ms, tz);
    return zonedTimeToMillis(q.year, q.month, q.day, 0, 0, tz);
  };
  const addDays = (ms: number, n: number) => {
    const q = zonedParts(ms, tz);
    return zonedTimeToMillis(q.year, q.month, q.day + n, q.hour, q.minute, tz);
  };
  /** Whole days from a to b (both day starts), DST-safe. */
  const daysBetween = (a: number, b: number) => Math.round((b - a) / 86_400_000);

  let cursor = $state<number | null>(null);
  const span = $derived(Math.max(7, Math.min(180, days)));
  const from = $derived(dayStartOf(addDays(cursor ?? date ?? Date.now(), cursor || date ? 0 : -7)));
  const dayList = $derived(Array.from({ length: span }, (_, i) => addDays(from, i)));
  const todayStart = $derived(dayStartOf(Date.now()));

  type Row = { kind: 'group'; name: string } | { kind: 'item'; it: TimelineItem };
  const rows = $derived.by((): Row[] => {
    const valid = items.filter((x) => typeof x.start === 'number');
    if (!valid.some((x) => x.group)) return valid.map((it) => ({ kind: 'item', it }));
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- built fresh by the derived
    const g = new Map<string, TimelineItem[]>();
    for (const it of valid) {
      const k = it.group || '—';
      const l = g.get(k);
      if (l) l.push(it);
      else g.set(k, [it]);
    }
    return [...g].flatMap(([name, list]) => [
      { kind: 'group' as const, name },
      ...list.map((it) => ({ kind: 'item' as const, it })),
    ]);
  });

  const barOf = (it: TimelineItem) => {
    const s = daysBetween(from, dayStartOf(it.start));
    const e = daysBetween(from, dayStartOf(Math.max(it.start, it.end ?? it.start)));
    return { left: s * DAY_W, width: (e - s + 1) * DAY_W - 4 };
  };

  // ── dragging: whole days ──
  let drag = $state<{ id: string; mode: 'move' | 'end'; x0: number; dx: number } | null>(null);
  function down(e: PointerEvent, it: TimelineItem, mode: 'move' | 'end') {
    if (!can.move) return;
    e.preventDefault();
    e.stopPropagation();
    drag = { id: it.id, mode, x0: e.clientX, dx: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (drag) drag = { ...drag, dx: e.clientX - drag.x0 };
  }
  function up(it: TimelineItem) {
    const d = drag;
    drag = null;
    if (!d) return;
    const n = Math.round(d.dx / DAY_W);
    if (!n) {
      if (Math.abs(d.dx) < 4 && can.open) send('onOpen', [{ id: it.id }]);
      return;
    }
    const end = it.end ?? it.start;
    if (d.mode === 'move')
      send('onMove', [
        { id: it.id, start: addDays(it.start, n), end: it.end != null ? addDays(end, n) : null },
      ]);
    else {
      const next = addDays(end, n);
      send('onMove', [{ id: it.id, start: it.start, end: Math.max(it.start, next) }]);
    }
  }
  const fmt = (ms: number, o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(undefined, { ...o, timeZone: tz }).format(new Date(ms));
</script>

<div class="flex flex-col gap-2" data-widget="timeline">
  <div class="flex items-center gap-2">
    <Button
      size="sm"
      variant="ghost"
      aria-label="Earlier"
      onclick={() => (cursor = addDays(from, -14))}><ChevronLeft size={14} /></Button
    >
    <Button
      size="sm"
      variant="ghost"
      aria-label="Later"
      onclick={() => (cursor = addDays(from, 14))}><ChevronRight size={14} /></Button
    >
    <Button size="sm" variant="ghost" onclick={() => (cursor = addDays(Date.now(), -7))}
      >Today</Button
    >
    <span class="text-sm font-semibold"
      >{fmt(from, { month: 'short', day: 'numeric' })} – {fmt(dayList[dayList.length - 1] ?? from, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })}</span
    >
  </div>
  <div class="overflow-auto rounded-lg border border-line">
    <div style="width:{LABEL_W + span * DAY_W}px">
      <div class="sticky top-0 z-10 flex border-b border-line bg-surface-2 text-[10px] text-muted">
        <div class="shrink-0 px-2 py-1" style="width:{LABEL_W}px"></div>
        {#each dayList as d (d)}
          <div
            class="shrink-0 border-l border-line/60 py-1 text-center {d === todayStart
              ? 'font-semibold text-accent'
              : ''}"
            style="width:{DAY_W}px"
            title={fmt(d, { weekday: 'short', month: 'short', day: 'numeric' })}
          >
            {fmt(d, { day: 'numeric' })}
          </div>
        {/each}
      </div>
      {#each rows as r, i (r.kind === 'group' ? `g:${r.name}` : `i:${r.it.id}:${i}`)}
        {#if r.kind === 'group'}
          <div class="border-b border-line bg-surface-2/60 px-2 py-1 text-xs font-medium">
            {r.name}
          </div>
        {:else}
          {@const b = barOf(r.it)}
          {@const live = drag?.id === r.it.id ? drag : null}
          <div class="flex h-8 items-center border-b border-line/60 text-sm">
            <button
              type="button"
              class="shrink-0 truncate px-2 text-left hover:text-accent"
              style="width:{LABEL_W}px"
              onclick={() => can.open && send('onOpen', [{ id: r.it.id }])}>{r.it.title}</button
            >
            <div class="relative h-full" style="width:{span * DAY_W}px">
              <div
                class="absolute inset-y-0 border-l border-accent/50"
                style="left:{daysBetween(from, todayStart) * DAY_W + DAY_W / 2}px"
              ></div>
              <div
                role="button"
                tabindex="0"
                data-item={r.it.id}
                class="absolute top-1.5 h-5 rounded {can.move
                  ? 'cursor-grab'
                  : 'cursor-pointer'} touch-none"
                style="left:{b.left + 2 + (live?.mode === 'move' ? live.dx : 0)}px;width:{Math.max(
                  DAY_W - 4,
                  b.width + (live?.mode === 'end' ? live.dx : 0),
                )}px;background:color-mix(in srgb, {r.it.color ||
                  'var(--tm-accent)'} 55%, transparent)"
                title={r.it.title}
                onpointerdown={(e) => down(e, r.it, 'move')}
                onpointermove={move}
                onpointerup={() => up(r.it)}
                onkeydown={(e) =>
                  e.key === 'Enter' && can.open && send('onOpen', [{ id: r.it.id }])}
              >
                {#if can.move}
                  <span
                    class="absolute top-0 right-0 h-full w-1.5 cursor-ew-resize"
                    role="presentation"
                    onpointerdown={(e) => down(e, r.it, 'end')}
                    onpointermove={move}
                    onpointerup={() => up(r.it)}
                  ></span>
                {/if}
              </div>
            </div>
          </div>
        {/if}
      {:else}
        <p class="p-4 text-sm text-muted">Nothing to show.</p>
      {/each}
    </div>
  </div>
</div>

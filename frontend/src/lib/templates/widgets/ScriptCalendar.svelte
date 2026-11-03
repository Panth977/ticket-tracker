<!--
  h.calendar (docs/plan/board-script.html §previews): the app's own calendar,
  drawn from a board script's items.

    h.calendar({ items: [{ id, title, start, end?, allDay?, color? }], view: 'month' | 'week',
                 date, weekStartsOn, onOpen({ id }), onMove({ id, start, end }), onDateChange({ date, view }) })

  Month: 6 weeks of days. Week: one row of 7 taller days. Drag a chip to another
  day → onMove with the same time of day on the new day (and `end` shifted by
  as much). A click → onOpen.
-->
<script lang="ts" module>
  export interface CalItem {
    id: string;
    title: string;
    start: number;
    end?: number | null;
    allDay?: boolean;
    color?: string | null;
  }
</script>

<script lang="ts">
  import { ChevronLeft, ChevronRight } from 'lucide-svelte';
  import { zonedParts, zonedTimeToMillis } from '@tm/shared/logic/time';
  import Button from '$lib/ui/Button.svelte';
  import { addMonths, monthGrid } from '$lib/ui/calendar';

  interface Props {
    items?: CalItem[];
    view?: 'month' | 'week';
    date?: number | null;
    weekStartsOn?: number;
    tz: string;
    /** The script gave onOpen / onMove / onDateChange (draggable only with onMove). */
    can: { open: boolean; move: boolean; date: boolean };
    send: (prop: string, args: unknown[]) => void;
  }
  let {
    items = [],
    view = 'month',
    date = null,
    weekStartsOn = 1,
    tz,
    can,
    send,
  }: Props = $props();

  const DAY = 86_400_000;
  let cursor = $state<number | null>(null);
  let mode = $state<'month' | 'week' | null>(null);
  const at = $derived(cursor ?? date ?? Date.now());
  const shown = $derived(mode ?? view);
  const today = $derived(zonedParts(Date.now(), tz));
  const p = $derived(zonedParts(at, tz));
  const dayStartOf = (ms: number) => {
    const q = zonedParts(ms, tz);
    return zonedTimeToMillis(q.year, q.month, q.day, 0, 0, tz);
  };

  const cells = $derived.by(() => {
    if (shown === 'month')
      return monthGrid(p.year, p.month, weekStartsOn).map((d) => ({
        ...d,
        start: zonedTimeToMillis(d.year, d.month, d.day, 0, 0, tz),
      }));
    const back = (p.weekday - weekStartsOn + 7) % 7;
    return Array.from({ length: 7 }, (_, i) => {
      const s = zonedTimeToMillis(p.year, p.month, p.day - back + i, 0, 0, tz);
      const q = zonedParts(s, tz);
      return { year: q.year, month: q.month, day: q.day, inMonth: true, start: s };
    });
  });
  const weekdays = $derived(
    Array.from({ length: 7 }, (_, i) =>
      new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2024, 0, 7 + ((weekStartsOn + i) % 7))),
      ),
    ),
  );
  const title = $derived(
    new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(Date.UTC(p.year, p.month - 1, 1)),
    ),
  );
  /** day start → the items on it (an item spanning days shows on each). */
  const byDay = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- built fresh by the derived
    const m = new Map<number, CalItem[]>();
    const first = cells[0]?.start ?? 0;
    const lastStart = cells[cells.length - 1]?.start ?? 0;
    for (const it of items) {
      if (typeof it.start !== 'number') continue;
      let d = dayStartOf(it.start);
      const endDay = dayStartOf(Math.max(it.start, it.end ?? it.start));
      for (let n = 0; d <= endDay && n < 62; n++) {
        if (d >= first && d <= lastStart) {
          const list = m.get(d);
          if (list) list.push(it);
          else m.set(d, [it]);
        }
        const q = zonedParts(d, tz);
        d = zonedTimeToMillis(q.year, q.month, q.day + 1, 0, 0, tz);
      }
    }
    return m;
  });

  function go(n: number) {
    const next =
      shown === 'month'
        ? (() => {
            const m = addMonths(p.year, p.month, n);
            return zonedTimeToMillis(m.year, m.month, 1, 0, 0, tz);
          })()
        : at + n * 7 * DAY;
    cursor = next;
    if (can.date) send('onDateChange', [{ date: next, view: shown }]);
  }
  function setMode(v: 'month' | 'week') {
    mode = v;
    if (can.date) send('onDateChange', [{ date: at, view: v }]);
  }

  let dragging = $state<string | null>(null);
  let over = $state<number | null>(null);
  function drop(dayStart: number) {
    const id = dragging;
    dragging = null;
    over = null;
    const it = items.find((x) => x.id === id);
    if (!it || !can.move) return;
    const delta = dayStart - dayStartOf(it.start);
    if (!delta) return;
    send('onMove', [
      { id: it.id, start: it.start + delta, end: it.end != null ? it.end + delta : null },
    ]);
  }
  const MAX = 4;
  let expanded = $state<Set<number>>(new Set());
</script>

<div class="flex flex-col gap-2" data-widget="calendar">
  <div class="flex items-center gap-2">
    <Button size="sm" variant="ghost" aria-label="Previous" onclick={() => go(-1)}
      ><ChevronLeft size={14} /></Button
    >
    <Button size="sm" variant="ghost" aria-label="Next" onclick={() => go(1)}
      ><ChevronRight size={14} /></Button
    >
    <Button
      size="sm"
      variant="ghost"
      onclick={() => {
        cursor = Date.now();
        if (can.date) send('onDateChange', [{ date: cursor, view: shown }]);
      }}>Today</Button
    >
    <h3 class="text-sm font-semibold">{title}</h3>
    <span class="flex-1"></span>
    <div class="flex rounded-md border border-line text-xs">
      {#each ['month', 'week'] as const as v (v)}
        <button
          type="button"
          class="px-2 py-1 first:rounded-l-md last:rounded-r-md {shown === v
            ? 'bg-accent-soft text-accent'
            : 'text-muted hover:bg-surface-2'}"
          aria-pressed={shown === v}
          onclick={() => setMode(v)}>{v === 'month' ? 'Month' : 'Week'}</button
        >
      {/each}
    </div>
  </div>
  <div class="grid grid-cols-7 overflow-hidden rounded-lg border border-line">
    {#each weekdays as w (w)}
      <div class="border-b border-line bg-surface-2 px-2 py-1 text-xs font-medium text-muted">
        {w}
      </div>
    {/each}
    {#each cells as c (c.start)}
      {@const list = byDay.get(c.start) ?? []}
      {@const isToday = c.year === today.year && c.month === today.month && c.day === today.day}
      <div
        role="gridcell"
        tabindex="-1"
        class="flex flex-col gap-0.5 border-t border-l border-line p-1 first:border-l-0 {shown ===
        'week'
          ? 'min-h-72'
          : 'min-h-24'} {c.inMonth ? 'bg-surface' : 'bg-surface-2/50'} {over === c.start
          ? 'ring-2 ring-accent ring-inset'
          : ''}"
        ondragover={(e) => {
          if (!dragging) return;
          e.preventDefault();
          over = c.start;
        }}
        ondragleave={() => over === c.start && (over = null)}
        ondrop={(e) => {
          e.preventDefault();
          drop(c.start);
        }}
      >
        <span
          class="self-end px-1 text-xs {isToday
            ? 'rounded-full bg-accent text-white'
            : c.inMonth
              ? 'text-muted'
              : 'text-subtle'}">{c.day}</span
        >
        {#each expanded.has(c.start) ? list : list.slice(0, MAX) as it (it.id)}
          <button
            type="button"
            draggable={can.move}
            data-item={it.id}
            class="truncate rounded px-1.5 py-0.5 text-left text-xs hover:brightness-95"
            style="background: color-mix(in srgb, {it.color ||
              'var(--tm-accent)'} 18%, transparent)"
            title={it.title}
            onclick={() => can.open && send('onOpen', [{ id: it.id }])}
            ondragstart={(e) => {
              dragging = it.id;
              e.dataTransfer?.setData('text/plain', it.id);
            }}
            ondragend={() => {
              dragging = null;
              over = null;
            }}>{it.title}</button
          >
        {/each}
        {#if list.length > MAX && !expanded.has(c.start)}
          <button
            type="button"
            class="px-1 text-left text-xs text-muted hover:text-text"
            onclick={() => (expanded = new Set([...expanded, c.start]))}
            >+{list.length - MAX} more</button
          >
        {/if}
      </div>
    {/each}
  </div>
</div>

<!--
  A due / start date. Dates the user picks are Millis + an allDay flag, in the
  person's time zone (an all-day date is stored as that day's 00:00 in `tz`).
  <DatePicker label="Due" bind:value={dueAt} bind:allDay tz={auth.profile?.timezone} />
-->
<script lang="ts">
  import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-svelte';
  import { addDaysTz, startOfDayTz, zonedParts, zonedTimeToMillis } from '@tm/shared/logic/time';
  import { addMonths, browserTimeZone, monthGrid } from './calendar';
  import Popover from './Popover.svelte';
  import { uid } from './ids';

  interface Props {
    value?: number | null;
    allDay?: boolean;
    tz?: string | null;
    label?: string;
    placeholder?: string;
    /** Offer a time input (clears allDay when used). */
    withTime?: boolean;
    disabled?: boolean;
    onchange?: (value: number | null, allDay: boolean) => void;
    class?: string;
  }
  let {
    value = $bindable(null),
    allDay = $bindable(true),
    tz,
    label,
    placeholder = 'No date',
    withTime = true,
    disabled = false,
    onchange,
    class: cls = '',
  }: Props = $props();

  const id = uid('date');
  const zone = $derived(tz || browserTimeZone());
  let open = $state(false);
  let anchor: HTMLButtonElement | null = $state(null);

  const now = () => Date.now();
  let view = $state({ year: 0, month: 0 });
  $effect.pre(() => {
    if (view.year === 0) {
      const p = zonedParts(value ?? now(), zone);
      view = { year: p.year, month: p.month };
    }
  });
  const grid = $derived(view.year ? monthGrid(view.year, view.month) : []);
  const sel = $derived(value != null ? zonedParts(value, zone) : null);
  const today = $derived(zonedParts(now(), zone));
  const monthName = $derived(
    new Date(Date.UTC(view.year, view.month - 1, 1)).toLocaleString(undefined, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }),
  );
  const timeStr = $derived(
    sel && !allDay
      ? `${String(sel.hour).padStart(2, '0')}:${String(sel.minute).padStart(2, '0')}`
      : '',
  );

  const display = $derived.by(() => {
    if (value == null) return placeholder;
    const opts: Intl.DateTimeFormatOptions = {
      timeZone: zone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    };
    if (!allDay) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
    if (sel && sel.year !== today.year) opts.year = 'numeric';
    return new Date(value).toLocaleString(undefined, opts);
  });

  function set(v: number | null, ad: boolean) {
    value = v;
    allDay = ad;
    onchange?.(v, ad);
  }
  function pickDay(y: number, m: number, d: number) {
    if (allDay || !sel) set(zonedTimeToMillis(y, m, d, 0, 0, zone), allDay || !sel ? true : allDay);
    else set(zonedTimeToMillis(y, m, d, sel.hour, sel.minute, zone), false);
    if (allDay) open = false;
  }
  function setTime(t: string) {
    const base = sel ?? today;
    if (!t) {
      set(zonedTimeToMillis(base.year, base.month, base.day, 0, 0, zone), true);
      return;
    }
    const [h, m] = t.split(':').map(Number);
    set(zonedTimeToMillis(base.year, base.month, base.day, h ?? 0, m ?? 0, zone), false);
  }
  function quick(days: number) {
    set(addDaysTz(startOfDayTz(now(), zone), days, zone), true);
    open = false;
  }
  function nextWeekday(target: number) {
    const w = zonedParts(now(), zone).weekday;
    quick((target - w + 7) % 7 || 7);
  }
  const isSel = (d: { year: number; month: number; day: number }) =>
    !!sel && sel.year === d.year && sel.month === d.month && sel.day === d.day;
  const isToday = (d: { year: number; month: number; day: number }) =>
    today.year === d.year && today.month === d.month && today.day === d.day;
</script>

<div class="flex flex-col gap-1 {cls}">
  {#if label}<label for={id} class="text-xs font-medium text-muted">{label}</label>{/if}
  <button
    bind:this={anchor}
    {id}
    type="button"
    {disabled}
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={() => {
      if (value != null)
        view = { year: zonedParts(value, zone).year, month: zonedParts(value, zone).month };
      open = !open;
    }}
    class="inline-flex h-8 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-left text-sm hover:bg-surface-2 disabled:opacity-60
      {value == null ? 'text-subtle' : 'text-text'}"
  >
    <CalendarDays size={15} class="text-muted" aria-hidden="true" />
    <span class="flex-1 truncate">{display}</span>
  </button>
</div>

<Popover bind:open {anchor} label={label ?? 'Pick a date'} class="w-72 p-3">
  <div class="mb-2 flex flex-wrap gap-1">
    <button
      type="button"
      class="rounded px-2 py-1 text-xs hover:bg-surface-2"
      onclick={() => quick(0)}>Today</button
    >
    <button
      type="button"
      class="rounded px-2 py-1 text-xs hover:bg-surface-2"
      onclick={() => quick(1)}>Tomorrow</button
    >
    <button
      type="button"
      class="rounded px-2 py-1 text-xs hover:bg-surface-2"
      onclick={() => nextWeekday(5)}>Friday</button
    >
    <button
      type="button"
      class="rounded px-2 py-1 text-xs hover:bg-surface-2"
      onclick={() => nextWeekday(1)}>Next Monday</button
    >
  </div>
  <div class="mb-1 flex items-center justify-between">
    <button
      type="button"
      aria-label="Previous month"
      class="rounded p-1 hover:bg-surface-2"
      onclick={() => (view = addMonths(view.year, view.month, -1))}
      ><ChevronLeft size={16} /></button
    >
    <span class="text-sm font-medium">{monthName}</span>
    <button
      type="button"
      aria-label="Next month"
      class="rounded p-1 hover:bg-surface-2"
      onclick={() => (view = addMonths(view.year, view.month, 1))}
      ><ChevronRight size={16} /></button
    >
  </div>
  <div class="grid grid-cols-7 text-center text-[11px] text-subtle">
    {#each ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as d (d)}<span class="py-1">{d}</span>{/each}
  </div>
  <div class="grid grid-cols-7 gap-0.5" role="grid" aria-label={monthName}>
    {#each grid as d (`${d.year}-${d.month}-${d.day}`)}
      <button
        type="button"
        aria-pressed={isSel(d)}
        onclick={() => pickDay(d.year, d.month, d.day)}
        class="h-8 rounded text-sm
          {isSel(d) ? 'bg-accent text-accent-fg' : 'hover:bg-surface-2'}
          {d.inMonth ? '' : 'text-subtle'}
          {isToday(d) && !isSel(d) ? 'font-semibold text-accent' : ''}">{d.day}</button
      >
    {/each}
  </div>
  <div class="mt-3 flex items-center gap-2 border-t border-line pt-3">
    {#if withTime}
      <input
        type="time"
        aria-label="Time"
        value={timeStr}
        onchange={(e) => setTime(e.currentTarget.value)}
        class="h-7 rounded border border-line bg-surface px-1.5 text-xs"
      />
      {#if !allDay}<button
          type="button"
          class="text-xs text-muted hover:text-text"
          onclick={() => setTime('')}>All day</button
        >{/if}
    {/if}
    <span class="flex-1"></span>
    {#if value != null}
      <button
        type="button"
        class="inline-flex items-center gap-1 text-xs text-muted hover:text-danger"
        onclick={() => {
          set(null, true);
          open = false;
        }}><X size={12} /> Clear</button
      >
    {/if}
  </div>
</Popover>

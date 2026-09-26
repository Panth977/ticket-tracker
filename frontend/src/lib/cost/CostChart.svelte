<!--
  COST PER DAY (docs/plan/agents.html §Y3) — inline SVG in the house style,
  like the usage panel's sparkline; no chart library.

  One series (the day's cost) in the accent, so no legend. Bars are thin
  (≤ 24px, 4px rounded top, square at the baseline) with a 2px surface gap
  between neighbours; an empty day is an empty slot, not a zero bar. Gridlines
  are solid hairlines one step off the surface; the y-axis picks round steps
  (./aggregate › axisSteps). Only the range's highest bar is labelled — the
  axis, the tooltip and the table under the chart carry the rest.

  Hover / tap / keyboard focus on a slot shows the day, its cost, its turns and
  its top tickets; the hovered bar lifts. Every slot is a hit target the full
  height of the plot, wider than the bar. On a phone the slots shrink to 6px
  and, past that, the chart scrolls sideways (§U).
-->
<script lang="ts">
  import { axisSteps, labelIndices, longDay, shortDay, topOfDay, type DayRow } from './aggregate';
  import { fmtTurns, fmtUsd, fmtUsdExact } from './format';

  interface Props {
    /** The range's days, ascending. */
    days: readonly string[];
    /** One row per day, null where nothing was spent (fillDays). */
    slots: readonly (DayRow | null)[];
    /** Held at reduced opacity while the rows are on their way (no skeleton, no jump). */
    loading?: boolean;
    class?: string;
  }
  let { days, slots, loading = false, class: cls = '' }: Props = $props();

  // ── geometry ────────────────────────────────────────────────────────────
  const PAD_L = 44;
  const PAD_R = 8;
  const PAD_T = 18;
  const PAD_B = 22;
  const PLOT_H = 180;
  const HEIGHT = PAD_T + PLOT_H + PAD_B;
  const MIN_SLOT = 6;
  const MAX_BAR = 24;
  const R = 4;

  let width = $state(0);
  const n = $derived(days.length);
  const plotW = $derived(Math.max(0, width - PAD_L - PAD_R));
  const slot = $derived(n ? Math.max(MIN_SLOT, Math.floor(plotW / n)) : MIN_SLOT);
  /** Wider than the box when the slots would go under 6px: the wrapper scrolls. */
  const svgW = $derived(Math.max(width, PAD_L + n * slot + PAD_R));
  const barW = $derived(Math.max(2, Math.min(MAX_BAR, slot - 2)));

  const values = $derived(slots.map((s) => s?.costUsd ?? 0));
  const maxV = $derived(Math.max(0, ...values));
  const axis = $derived(axisSteps(maxV));
  const maxI = $derived(maxV > 0 ? values.indexOf(maxV) : -1);
  const xLabels = $derived(new Set(labelIndices(n, Math.max(2, Math.floor(plotW / 56)))));

  const x = (i: number) => PAD_L + i * slot + (slot - barW) / 2;
  const y = (v: number) => PAD_T + PLOT_H * (1 - (axis.max ? v / axis.max : 0));
  const baseline = PAD_T + PLOT_H;

  /** A bar: rounded at the top, square on the baseline; a sliver when shorter than the radius. */
  function bar(i: number, v: number): string {
    const x0 = x(i);
    const top = y(v);
    const h = baseline - top;
    if (h <= 0) return '';
    const r = Math.min(R, h, barW / 2);
    return `M${x0},${top + r} a${r},${r} 0 0 1 ${r},-${r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} V${baseline} H${x0} Z`;
  }

  // ── hover / focus ───────────────────────────────────────────────────────
  let hovered = $state<number | null>(null);
  let box: HTMLElement | null = $state(null);
  const tip = $derived.by(() => {
    if (hovered == null) return null;
    const row = slots[hovered] ?? null;
    return { i: hovered, day: days[hovered]!, row, top: topOfDay(row, 3) };
  });
  /** Tooltip x in the (possibly scrolled) wrapper: centred on the slot, clamped to the box. */
  const tipLeft = $derived.by(() => {
    if (!tip) return 0;
    const cx = PAD_L + tip.i * slot + slot / 2;
    const w = 200;
    return Math.max(4, Math.min(cx - w / 2, svgW - w - 4));
  });

  function label(i: number): string {
    const row = slots[i];
    return row
      ? `${longDay(days[i]!)}: ${fmtUsdExact(row.costUsd)} over ${fmtTurns(row.runs)}`
      : `${longDay(days[i]!)}: nothing spent`;
  }
</script>

<div
  bind:this={box}
  bind:clientWidth={width}
  class="relative w-full overflow-x-auto overflow-y-hidden {cls}"
  role="group"
  aria-label="Cost per day"
  onpointerleave={() => (hovered = null)}
>
  {#if width}
    <svg
      width={svgW}
      height={HEIGHT}
      viewBox="0 0 {svgW} {HEIGHT}"
      class="block select-none transition-opacity {loading ? 'opacity-50' : ''}"
      style="min-width:{svgW}px"
      role="img"
      aria-label="Bar chart of agent cost per day, {days[0] ? longDay(days[0]) : ''} to {days[n - 1]
        ? longDay(days[n - 1]!)
        : ''}"
      onpointerdown={(e) => {
        // A tap on empty chart space dismisses the tooltip (touch has no 'leave').
        if ((e.target as Element).tagName === 'svg') hovered = null;
      }}
    >
      <!-- gridlines + y ticks: recessive, solid hairlines -->
      {#each axis.ticks as t (t)}
        <line
          x1={PAD_L}
          x2={svgW - PAD_R}
          y1={y(t)}
          y2={y(t)}
          stroke="var(--tm-line)"
          stroke-width="1"
          shape-rendering="crispEdges"
        />
        <text
          x={PAD_L - 6}
          y={y(t)}
          dy="0.35em"
          text-anchor="end"
          font-size="10"
          fill="var(--tm-subtle)"
          style="font-variant-numeric: tabular-nums">{fmtUsd(t)}</text
        >
      {/each}

      <!-- x labels: every k-th day, anchored on today -->
      {#each days as d, i (d)}
        {#if xLabels.has(i)}
          <text
            x={PAD_L + i * slot + slot / 2}
            y={baseline + 14}
            text-anchor="middle"
            font-size="10"
            fill="var(--tm-subtle)">{shortDay(d)}</text
          >
        {/if}
      {/each}

      <!-- the bars -->
      {#each slots as row, i (days[i])}
        {#if row && row.costUsd > 0}
          <path
            d={bar(i, row.costUsd)}
            fill={hovered === i ? 'var(--tm-accent-hover)' : 'var(--tm-accent)'}
            data-day={days[i]}
          />
        {/if}
      {/each}

      <!-- the one direct label: the range's highest day -->
      {#if maxI >= 0 && hovered !== maxI}
        <text
          x={PAD_L + maxI * slot + slot / 2}
          y={y(maxV) - 5}
          text-anchor="middle"
          font-size="10"
          font-weight="600"
          fill="var(--tm-text)"
          style="font-variant-numeric: tabular-nums">{fmtUsd(maxV)}</text
        >
      {/if}

      <!-- hit targets: the whole slot, the whole plot height, keyboard-reachable -->
      {#each days as d, i (d)}
        <!-- A data point is focusable so keyboard users get the same tooltip as hover. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <rect
          x={PAD_L + i * slot}
          y={PAD_T}
          width={slot}
          height={PLOT_H}
          fill="transparent"
          tabindex="0"
          role="img"
          aria-label={label(i)}
          class="cursor-default outline-none"
          onpointerenter={() => (hovered = i)}
          onpointerdown={() => (hovered = i)}
          onfocus={() => (hovered = i)}
          onblur={() => (hovered = null)}
        />
      {/each}
    </svg>
  {/if}

  {#if tip}
    <div
      role="tooltip"
      class="pointer-events-none absolute z-10 w-50 rounded-md border border-line bg-surface p-2 text-xs shadow-pop"
      style="left:{tipLeft}px; top:{PAD_T}px"
      data-chart-tip
    >
      <p class="font-medium text-text">{longDay(tip.day)}</p>
      {#if tip.row}
        <p class="mt-0.5 tabular-nums">
          <span class="text-base font-semibold text-text">{fmtUsdExact(tip.row.costUsd)}</span>
          <span class="text-muted">· {fmtTurns(tip.row.runs)}</span>
        </p>
        {#if tip.top.length}
          <ul class="mt-1 flex flex-col gap-0.5 border-t border-line pt-1">
            {#each tip.top as t (t.key)}
              <li class="flex items-baseline gap-2 tabular-nums">
                <span class="inline-block h-2 w-0.5 rounded-sm bg-accent" aria-hidden="true"></span>
                <span class="font-mono text-muted">{t.key}</span>
                <span class="ml-auto text-text">{fmtUsdExact(t.usd)}</span>
                <span class="text-subtle">{t.runs}×</span>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p class="mt-0.5 text-muted">Nothing spent</p>
      {/if}
    </div>
  {/if}
</div>

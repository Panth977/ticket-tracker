<!--
  ONE FIELD PER BUCKET (docs/plan/aggregates.html; was the cost chart of
  agents.html §Y3) — inline SVG in the house style; no chart library.

  One series (the field's total per day / week / month) in the accent, so no
  legend. Bars are thin (≤ 24px, 4px rounded at the end away from zero) with a
  2px surface gap between neighbours; an empty bucket is an empty slot, not a
  zero bar. A negative total (entries take away) hangs below the zero line.
  Gridlines are solid hairlines; the y-axis picks round steps
  ($lib/cost/aggregate › axisSteps). Only the range's highest bar is
  labelled — the axis, the tooltip and the table carry the rest.

  Hover / tap / keyboard focus on a slot shows the bucket, its total, its
  entries and its top tickets. Every slot is a hit target the full height of
  the plot. On a phone the slots shrink to 6px and, past that, the chart
  scrolls sideways (§U).
-->
<script lang="ts">
  import { formatAgg, type AggPeriod } from '@tm/shared';
  import { axisSteps, labelIndices } from '$lib/cost/aggregate';
  import { entriesWord } from './fields';
  import { longBucket, shortBucket, topOfBucket, type AggBucket } from './periods';

  interface Props {
    period: AggPeriod;
    /** The field's unit ('$', 'h', '') — every number is drawn with it. */
    unit: string;
    /** 'Cost', 'Time' — for the accessible name. */
    label: string;
    /** The range's keys, ascending. */
    keys: readonly string[];
    /** One bucket per key, null where nothing landed (fillBuckets). */
    slots: readonly (AggBucket | null)[];
    /** Held at reduced opacity while the rows are on their way (no skeleton, no jump). */
    loading?: boolean;
    class?: string;
  }
  let {
    period,
    unit,
    label: fieldLabel,
    keys,
    slots,
    loading = false,
    class: cls = '',
  }: Props = $props();

  const fmt = (v: number) => formatAgg(v, unit);
  /** Axis labels: compact (no 4-decimal tails). */
  const fmtAxis = (v: number) => formatAgg(v, unit, { digits: Math.abs(v) < 1 && v !== 0 ? 2 : 1 });

  // ── geometry ────────────────────────────────────────────────────────────
  const PAD_L = 48;
  const PAD_R = 8;
  const PAD_T = 18;
  const PAD_B = 22;
  const PLOT_H = 180;
  const HEIGHT = PAD_T + PLOT_H + PAD_B;
  const MIN_SLOT = 6;
  const MAX_BAR = 24;
  const R = 4;

  let width = $state(0);
  const n = $derived(keys.length);
  const plotW = $derived(Math.max(0, width - PAD_L - PAD_R));
  const slot = $derived(n ? Math.max(MIN_SLOT, Math.floor(plotW / n)) : MIN_SLOT);
  const svgW = $derived(Math.max(width, PAD_L + n * slot + PAD_R));
  const barW = $derived(Math.max(2, Math.min(MAX_BAR, slot - 2)));

  const values = $derived(slots.map((s) => s?.total ?? 0));
  const maxV = $derived(Math.max(0, ...values));
  const minV = $derived(Math.min(0, ...values));
  /** Round steps over the whole span; the negative side reuses the step. */
  const axis = $derived.by(() => {
    const span = axisSteps(Math.max(maxV, -minV, 0));
    const top = maxV > 0 ? Math.ceil(maxV / span.step - 1e-9) * span.step : minV < 0 ? 0 : span.max;
    const bottom = minV < 0 ? -Math.ceil(-minV / span.step - 1e-9) * span.step : 0;
    const ticks: number[] = [];
    for (let v = bottom; v <= top + span.step / 2; v += span.step)
      ticks.push(Math.round(v * 1e6) / 1e6);
    return { top, bottom, ticks };
  });
  const maxI = $derived(maxV > 0 ? values.indexOf(maxV) : -1);
  const xLabels = $derived(new Set(labelIndices(n, Math.max(2, Math.floor(plotW / 56)))));

  const x = (i: number) => PAD_L + i * slot + (slot - barW) / 2;
  const y = (v: number) => {
    const range = axis.top - axis.bottom || 1;
    return PAD_T + PLOT_H * (1 - (v - axis.bottom) / range);
  };
  const zero = $derived(y(0));

  /** A bar from zero to v: rounded at the far end, square on the zero line. */
  function bar(i: number, v: number): string {
    const x0 = x(i);
    const end = y(v);
    const h = Math.abs(zero - end);
    if (h <= 0) return '';
    const r = Math.min(R, h, barW / 2);
    if (v > 0)
      return `M${x0},${end + r} a${r},${r} 0 0 1 ${r},-${r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} V${zero} H${x0} Z`;
    return `M${x0},${zero} H${x0 + barW} V${end - r} a${r},${r} 0 0 1 -${r},${r} h-${barW - 2 * r} a${r},${r} 0 0 1 -${r},-${r} Z`;
  }

  // ── hover / focus ───────────────────────────────────────────────────────
  let hovered = $state<number | null>(null);
  const tip = $derived.by(() => {
    if (hovered == null) return null;
    const row = slots[hovered] ?? null;
    return { i: hovered, key: keys[hovered]!, row, top: topOfBucket(row, 3) };
  });
  const tipLeft = $derived.by(() => {
    if (!tip) return 0;
    const cx = PAD_L + tip.i * slot + slot / 2;
    const w = 200;
    return Math.max(4, Math.min(cx - w / 2, svgW - w - 4));
  });

  function label(i: number): string {
    const row = slots[i];
    const when = longBucket(period, keys[i]!);
    return row ? `${when}: ${fmt(row.total)} over ${entriesWord(row.count)}` : `${when}: nothing`;
  }
</script>

<div
  bind:clientWidth={width}
  class="relative w-full overflow-x-auto overflow-y-hidden {cls}"
  role="group"
  aria-label="{fieldLabel} per {period === 'daily'
    ? 'day'
    : period === 'weekly'
      ? 'week'
      : 'month'}"
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
      aria-label="Bar chart of {fieldLabel}, {keys[0] ? longBucket(period, keys[0]) : ''} to {keys[
        n - 1
      ]
        ? longBucket(period, keys[n - 1]!)
        : ''}"
      onpointerdown={(e) => {
        if ((e.target as Element).tagName === 'svg') hovered = null;
      }}
    >
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
          style="font-variant-numeric: tabular-nums">{fmtAxis(t)}</text
        >
      {/each}

      {#each keys as k, i (k)}
        {#if xLabels.has(i)}
          <text
            x={PAD_L + i * slot + slot / 2}
            y={PAD_T + PLOT_H + 14}
            text-anchor="middle"
            font-size="10"
            fill="var(--tm-subtle)">{shortBucket(period, k)}</text
          >
        {/if}
      {/each}

      {#each slots as row, i (keys[i])}
        {#if row && row.total !== 0}
          <path
            d={bar(i, row.total)}
            fill={hovered === i ? 'var(--tm-accent-hover)' : 'var(--tm-accent)'}
            data-bucket={keys[i]}
          />
        {/if}
      {/each}

      {#if maxI >= 0 && hovered !== maxI}
        <text
          x={PAD_L + maxI * slot + slot / 2}
          y={y(maxV) - 5}
          text-anchor="middle"
          font-size="10"
          font-weight="600"
          fill="var(--tm-text)"
          style="font-variant-numeric: tabular-nums">{fmtAxis(maxV)}</text
        >
      {/if}

      {#each keys as k, i (k)}
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
      <p class="font-medium text-text">{longBucket(period, tip.key)}</p>
      {#if tip.row}
        <p class="mt-0.5 tabular-nums">
          <span class="text-base font-semibold text-text">{fmt(tip.row.total)}</span>
          <span class="text-muted">· {entriesWord(tip.row.count)}</span>
        </p>
        {#if tip.top.length}
          <ul class="mt-1 flex flex-col gap-0.5 border-t border-line pt-1">
            {#each tip.top as t (t.key)}
              <li class="flex items-baseline gap-2 tabular-nums">
                <span class="inline-block h-2 w-0.5 rounded-sm bg-accent" aria-hidden="true"></span>
                <span class="font-mono text-muted">{t.key}</span>
                <span class="ml-auto text-text">{fmt(t.total)}</span>
                <span class="text-subtle">{t.count}×</span>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p class="mt-0.5 text-muted">Nothing</p>
      {/if}
    </div>
  {/if}
</div>

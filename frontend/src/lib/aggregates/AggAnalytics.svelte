<!--
  ANALYTICS for one board (docs/plan/aggregates.html; was agents.html §Y3's
  cost view), rendered inside Board settings › Analytics. Pick an aggregate
  field (Cost first); see its stat tiles, its total per day / week / month,
  and the tickets ranked by it. A page a phone can use.

  DATA: the bucket docs boards/{b}/aggStats/{period}:{key} of the field's
  period for the range, LIVE (one doc holds every field of that period); the
  lifetime total is the board's own counter (board.aggs, or the legacy
  board.cost before the migration). Buckets are cut in AGG_TZ.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { AGG_TZ, aggPeriodKey, formatAgg, type Board } from '@tm/shared';
  import { auth } from '$lib/firebase/auth.svelte';
  import { boardActiveTickets, type WithId } from '$lib/stores';
  import { routes } from '$lib/layout/routes';
  import AggChart from './AggChart.svelte';
  import { aggCountersOf, allAggFields, entriesWord } from './fields';
  import {
    bucketsOf,
    fillBuckets,
    longBucket,
    PERIOD_LABEL,
    PERIOD_RANGES,
    periodKeys,
    periodTiles,
    periodWord,
    rankBucketTickets,
    savedPeriodRange,
    savePeriodRange,
    sumBuckets,
  } from './periods';
  import { aggStatsStore } from './stats';

  interface Props {
    board: WithId<Board>;
  }
  let { board }: Props = $props();
  const boardId = $derived(board.id);

  // ── the field: the first active one by default; archived ones keep their history ──
  const fields = $derived(
    [...allAggFields(board)].sort((a, b) => Number(!!a.archived) - Number(!!b.archived)),
  );
  let chosen = $state<string | null>(null);
  const field = $derived(fields.find((f) => f.id === chosen) ?? fields[0] ?? null);
  const period = $derived(field?.period ?? 'daily');
  const fmt = (v: number) => formatAgg(v, field?.unit ?? '');

  // ── the range, per period, remembered on this device ────────────────────
  let ranges = $state<Record<string, number>>({});
  const range = $derived(ranges[period] ?? savedPeriodRange(period));
  function setRange(n: number) {
    ranges = { ...ranges, [period]: n };
    savePeriodRange(period, n);
  }

  // ── now, in the owner's clock; rolls over while the page is open ────────
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(t);
  });
  const current = $derived(aggPeriodKey(period, now));
  const keys = $derived(periodKeys(period, now, range));
  const from = $derived(keys[0] ?? null);

  // ── live data ───────────────────────────────────────────────────────────
  const stats = $derived(aggStatsStore(boardId, field ? period : null, from));
  const rows = $derived(field ? bucketsOf($stats.data, field.id) : []);
  const slots = $derived(fillBuckets(rows, keys));
  const inRange = $derived(sumBuckets(rows, from ?? undefined));
  const ranked = $derived(rankBucketTickets(rows, from ?? undefined));
  const lifetime = $derived((field && aggCountersOf(board)[field.id]) || { total: 0, count: 0 });
  const tilesOf = $derived(periodTiles(period, rows, current));
  const perTicket = $derived(inRange.tickets ? inRange.total / inRange.tickets : null);

  const active = $derived(boardActiveTickets(boardId, auth.uid));
  const titleOf = $derived(new Map<string, string>($active.data.map((t) => [t.key, t.title])));
  const per = $derived(period === 'daily' ? 'day' : period === 'weekly' ? 'week' : 'month');
</script>

<div class="flex flex-col gap-5" data-board-analytics>
  {#if !field}
    <p class="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
      This board has no aggregate fields. Add one in Settings › Aggregates.
    </p>
  {:else}
    <!-- ── header: which field, and the one filter (the range) ── -->
    <header class="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <label class="flex flex-col gap-1 text-xs text-muted">
        <span>Field</span>
        <select
          class="h-8 rounded-md border border-line bg-surface px-2 text-sm text-text"
          value={field.id}
          aria-label="Field"
          data-agg-field-select
          onchange={(e) => (chosen = e.currentTarget.value)}
        >
          {#each fields as f (f.id)}
            <option value={f.id}
              >{f.label}{f.unit ? ` (${f.unit})` : ''} · {PERIOD_LABEL[
                f.period
              ].toLowerCase()}{f.archived ? ' · archived' : ''}</option
            >
          {/each}
        </select>
      </label>
      <div class="flex flex-col items-end gap-1">
        <div
          class="inline-flex h-8 items-center rounded-md border border-line bg-surface p-0.5 text-xs"
          role="group"
          aria-label="Range"
        >
          {#each PERIOD_RANGES[period] as r (r)}
            <button
              type="button"
              aria-pressed={range === r}
              data-range={r}
              class="h-full rounded px-2.5 font-medium transition-colors {range === r
                ? 'bg-surface-3 text-text'
                : 'text-muted hover:text-text'}"
              onclick={() => setRange(r)}
            >
              {periodWord(period, r)}
            </button>
          {/each}
        </div>
        <p class="text-xs text-subtle">
          {PERIOD_LABEL[period]} buckets, cut in {AGG_TZ}{period === 'weekly'
            ? ' (ISO weeks)'
            : ''}.
        </p>
      </div>
    </header>

    <!-- ── the stat tiles ── -->
    <section class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Totals">
      <div class="rounded-xl border border-line bg-surface px-4 py-3" data-tile="total">
        <p class="text-xs text-muted">Total</p>
        <p class="mt-0.5 text-2xl font-semibold text-text">{fmt(lifetime.total)}</p>
        <p class="text-xs text-subtle">lifetime · {entriesWord(lifetime.count)}</p>
      </div>
      {#each tilesOf as t (t.id)}
        <div class="rounded-xl border border-line bg-surface px-4 py-3" data-tile={t.id}>
          <p class="text-xs text-muted">{t.label}</p>
          <p class="mt-0.5 text-2xl font-semibold text-text">{fmt(t.sum.total)}</p>
          <p class="text-xs text-subtle">{entriesWord(t.sum.count)}</p>
        </div>
      {/each}
      <div class="rounded-xl border border-line bg-surface px-4 py-3" data-tile="perTicket">
        <p class="text-xs text-muted">Per ticket</p>
        <p class="mt-0.5 text-2xl font-semibold text-text">
          {perTicket != null ? fmt(perTicket) : '—'}
        </p>
        <p class="text-xs text-subtle">
          {inRange.tickets
            ? `${inRange.tickets} ${inRange.tickets === 1 ? 'ticket' : 'tickets'} in ${periodWord(period, range)}`
            : `no entries in ${periodWord(period, range)}`}
        </p>
      </div>
    </section>

    <!-- ── total per bucket ── -->
    <section class="rounded-xl border border-line bg-surface" aria-labelledby="agg-by-bucket">
      <div class="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3">
        <h2 id="agg-by-bucket" class="text-sm font-semibold">{field.label} per {per}</h2>
        <p class="text-xs text-subtle">
          {longBucket(period, keys[0]!)} – {longBucket(period, current)} · {fmt(inRange.total)} over
          {entriesWord(inRange.count)}
        </p>
      </div>
      {#if $stats.error}
        <p class="px-4 py-6 text-sm text-danger">
          Couldn't load the totals: {$stats.error.message}
        </p>
      {:else if !$stats.loading && rows.length === 0}
        <div class="px-4 py-2">
          <AggChart
            {period}
            unit={field.unit}
            label={field.label}
            {keys}
            {slots}
            class="opacity-60"
          />
          <p class="pb-3 text-center text-sm text-muted">
            Nothing added to {field.label} in the last {periodWord(period, range)}. An entry lands
            here when someone posts one in a ticket's thread{field.id === 'cost'
              ? ', or an orchestrator finishes a run'
              : ''}.
          </p>
        </div>
      {:else}
        <div class="px-2 py-2 sm:px-4">
          <AggChart
            {period}
            unit={field.unit}
            label={field.label}
            {keys}
            {slots}
            loading={$stats.loading}
          />
        </div>
        <details class="border-t border-line px-4 py-2 text-xs">
          <summary class="cursor-pointer text-muted select-none hover:text-text">As a table</summary
          >
          <table class="mt-2 w-full text-left tabular-nums">
            <thead class="text-subtle">
              <tr>
                <th class="py-1 pr-2 font-medium">{per[0]!.toUpperCase() + per.slice(1)}</th>
                <th class="py-1 pr-2 text-right font-medium">{field.label}</th>
                <th class="py-1 pr-2 text-right font-medium">Entries</th>
                <th class="hidden py-1 font-medium sm:table-cell">Tickets</th>
              </tr>
            </thead>
            <tbody>
              {#each [...rows].reverse() as r (r.key)}
                <tr class="border-t border-line" data-bucket-row={r.key}>
                  <td class="py-1 pr-2 whitespace-nowrap">{longBucket(period, r.key)}</td>
                  <td class="py-1 pr-2 text-right">{fmt(r.total)}</td>
                  <td class="py-1 pr-2 text-right">{r.count}</td>
                  <td class="hidden py-1 font-mono text-muted sm:table-cell"
                    >{rankBucketTickets([r])
                      .map((t) => t.key)
                      .join(' ')}</td
                  >
                </tr>
              {/each}
            </tbody>
          </table>
        </details>
      {/if}
    </section>

    <!-- ── the tickets of the range, ranked ── -->
    <section class="rounded-xl border border-line bg-surface" aria-labelledby="by-ticket">
      <div class="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 pb-2">
        <h2 id="by-ticket" class="text-sm font-semibold">Tickets by {field.label}</h2>
        <p class="text-xs text-subtle">
          last {periodWord(period, range)}{#if inRange.tickets}
            · {inRange.tickets}
            {inRange.tickets === 1 ? 'ticket' : 'tickets'}{/if}
        </p>
      </div>
      {#if ranked.length === 0}
        <p class="px-4 pb-4 text-sm text-muted">No ticket had an entry in this range.</p>
      {:else}
        <ol class="divide-y divide-line" data-ranked>
          {#each ranked as t, i (t.key)}
            <li>
              <a
                href={routes.board(board.key, null, t.key)}
                data-ticket-row={t.key}
                class="flex items-center gap-3 px-4 py-2 text-sm hover:bg-surface-2"
              >
                <span class="w-5 shrink-0 text-right text-xs text-subtle tabular-nums">{i + 1}</span
                >
                <span class="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-2">
                  <span class="shrink-0 font-mono text-xs text-muted">{t.key}</span>
                  {#if titleOf.get(t.key)}
                    <span class="truncate">{titleOf.get(t.key)}</span>
                  {/if}
                </span>
                <span class="shrink-0 text-right tabular-nums">
                  <span class="font-medium text-text">{fmt(t.total)}</span>
                  <span class="block text-xs text-subtle sm:ml-2 sm:inline"
                    >{entriesWord(t.count)}</span
                  >
                </span>
              </a>
            </li>
          {/each}
        </ol>
      {/if}
    </section>
  {/if}
</div>

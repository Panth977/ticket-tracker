<!--
  ANALYTICS for one board (agents.html §Y3), rendered inside Board settings ›
  Analytics. Stat tiles, cost per day, tickets ranked by spend. A page a phone
  can use. DATA: the day rows boards/{b}/stats/{yyyy-mm-dd} for the range,
  LIVE; the lifetime total is the board's own counter (§Y2). Days are cut in
  COST_DAY_TZ (decision D-Y1).
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { Board } from '@tm/shared';
  import { COST_DAY_TZ, costDayOf } from '@tm/shared';
  import { auth } from '$lib/firebase/auth.svelte';
  import { boardActiveTickets, type WithId } from '$lib/stores';
  import { routes } from '$lib/layout/routes';
  import CostChart from '$lib/cost/CostChart.svelte';
  import { fillDays, longDay, rangeDays, rankTickets, tiles } from '$lib/cost/aggregate';
  import { fmtTurns, fmtUsd, fmtUsdExact } from '$lib/cost/format';
  import { boardStats, RANGES, saveRange, savedRange, type Range } from '$lib/cost/stats';

  interface Props {
    board: WithId<Board>;
  }
  let { board }: Props = $props();
  const boardId = $derived(board.id);

  // ── the range (30 / 90 days, remembered on this device) ─────────────────
  let range = $state<Range>(savedRange());
  function setRange(r: Range) {
    range = r;
    saveRange(r);
  }

  // ── today, in the owner's clock; rolls over while the page is open ──────
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(t);
  });
  const today = $derived(costDayOf(now));
  const days = $derived(rangeDays(today, range));
  const from = $derived(days[0] ?? null);

  // ── live data ───────────────────────────────────────────────────────────
  const stats = $derived(boardStats(boardId, from));
  const rows = $derived($stats.data);
  const slots = $derived(fillDays(rows, days));
  const sums = $derived(tiles(rows, today));
  const ranked = $derived(rankTickets(rows, from ?? undefined));
  const lifetime = $derived(board.cost ?? { usd: 0, runs: 0 });

  // Titles for the ranked rows, where the board still has the ticket live
  // (§W: the board's own incremental query — shared with the board page, so
  // it is not a second listener when you came from there). A key with no
  // live card (archived, deleted) is still a row: the money was spent.
  const active = $derived(boardActiveTickets(boardId, auth.uid));
  const titleOf = $derived(new Map<string, string>($active.data.map((t) => [t.key, t.title])));

  const statTiles = $derived([
    { id: 'total', label: 'Total', sum: lifetime, note: 'lifetime' },
    { id: 'month', label: 'This month', sum: sums.month, note: fmtTurns(sums.month.runs) },
    { id: 'week', label: 'Last 7 days', sum: sums.last7, note: fmtTurns(sums.last7.runs) },
    { id: 'today', label: 'Today', sum: sums.today, note: fmtTurns(sums.today.runs) },
  ]);

  const monthLabel = $derived(
    new Date(`${today.slice(0, 7)}-02T12:00:00Z`).toLocaleDateString('en-GB', {
      timeZone: 'UTC',
      month: 'long',
    }),
  );
</script>

<div class="flex flex-col gap-5" data-board-analytics>
  <!-- ── header: where we are, and the one filter (the range) ── -->
  <header class="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
    <p class="text-xs text-subtle">Days are cut in {COST_DAY_TZ}.</p>
    <div
      class="inline-flex h-8 items-center rounded-md border border-line bg-surface p-0.5 text-xs"
      role="group"
      aria-label="Range"
    >
      {#each RANGES as r (r)}
        <button
          type="button"
          aria-pressed={range === r}
          data-range={r}
          class="h-full rounded px-2.5 font-medium transition-colors {range === r
            ? 'bg-surface-3 text-text'
            : 'text-muted hover:text-text'}"
          onclick={() => setRange(r)}
        >
          {r} days
        </button>
      {/each}
    </div>
  </header>

  <!-- ── the stat tiles: total (the board's counter), then the day rows cut three ways ── -->
  <section class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Totals">
    {#each statTiles as t (t.id)}
      <div class="rounded-xl border border-line bg-surface px-4 py-3" data-tile={t.id}>
        <p class="text-xs text-muted">{t.label}</p>
        <p class="mt-0.5 text-2xl font-semibold text-text" title={fmtUsdExact(t.sum.usd)}>
          {fmtUsd(t.sum.usd)}
        </p>
        <p class="text-xs text-subtle">{t.note}</p>
      </div>
    {/each}
    <div
      class="col-span-2 rounded-xl border border-line bg-surface px-4 py-3 sm:col-span-1"
      data-tile="perTicket"
    >
      <p class="text-xs text-muted">Per ticket</p>
      <p
        class="mt-0.5 text-2xl font-semibold text-text"
        title={sums.perTicket != null ? fmtUsdExact(sums.perTicket) : undefined}
      >
        {sums.perTicket != null ? fmtUsd(sums.perTicket) : '—'}
      </p>
      <p class="text-xs text-subtle">
        {sums.range.tickets
          ? `${sums.range.tickets} ${sums.range.tickets === 1 ? 'ticket' : 'tickets'} in ${range} days`
          : `no receipts in ${range} days`}
      </p>
    </div>
  </section>

  <!-- ── cost per day ── -->
  <section class="rounded-xl border border-line bg-surface" aria-labelledby="cost-by-day">
    <div class="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3">
      <h2 id="cost-by-day" class="text-sm font-semibold">Cost per day</h2>
      <p class="text-xs text-subtle">
        {longDay(days[0]!)} – {longDay(today)} · {fmtUsdExact(sums.range.usd)} over {fmtTurns(
          sums.range.runs,
        )}
      </p>
    </div>
    {#if $stats.error}
      <p class="px-4 py-6 text-sm text-danger">
        Couldn't load the day rows: {$stats.error.message}
      </p>
    {:else if !$stats.loading && rows.length === 0}
      <div class="px-4 py-2">
        <CostChart {days} {slots} class="opacity-60" />
        <p class="pb-3 text-center text-sm text-muted">
          No turn receipts in the last {range} days. A receipt lands here when an orchestrator finishes
          a run on one of this board's tickets.
        </p>
      </div>
    {:else}
      <div class="px-2 py-2 sm:px-4">
        <CostChart {days} {slots} loading={$stats.loading} />
      </div>
      <!-- The chart's table twin: every value reachable without hovering. -->
      <details class="border-t border-line px-4 py-2 text-xs">
        <summary class="cursor-pointer text-muted select-none hover:text-text"
          >Days as a table</summary
        >
        <table class="mt-2 w-full text-left tabular-nums">
          <thead class="text-subtle">
            <tr>
              <th class="py-1 pr-2 font-medium">Day</th>
              <th class="py-1 pr-2 text-right font-medium">Cost</th>
              <th class="py-1 pr-2 text-right font-medium">Turns</th>
              <th class="hidden py-1 font-medium sm:table-cell">Tickets</th>
            </tr>
          </thead>
          <tbody>
            {#each [...rows].reverse() as r (r.day)}
              <tr class="border-t border-line">
                <td class="py-1 pr-2 whitespace-nowrap">{longDay(r.day)}</td>
                <td class="py-1 pr-2 text-right">{fmtUsdExact(r.costUsd)}</td>
                <td class="py-1 pr-2 text-right">{r.runs}</td>
                <td class="hidden py-1 font-mono text-muted sm:table-cell"
                  >{rankTickets([r])
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

  <!-- ── the tickets of the range, ranked by spend ── -->
  <section class="rounded-xl border border-line bg-surface" aria-labelledby="by-ticket">
    <div class="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 pb-2">
      <h2 id="by-ticket" class="text-sm font-semibold">Tickets by spend</h2>
      <p class="text-xs text-subtle">
        last {range} days{#if sums.range.tickets}
          · {sums.range.tickets}
          {sums.range.tickets === 1 ? 'ticket' : 'tickets'}{/if}
      </p>
    </div>
    {#if ranked.length === 0}
      <p class="px-4 pb-4 text-sm text-muted">No ticket had a turn in this range.</p>
    {:else}
      <ol class="divide-y divide-line" data-ranked>
        {#each ranked as t, i (t.key)}
          <li>
            <a
              href={routes.board(board.key, null, t.key)}
              data-ticket-row={t.key}
              class="flex items-center gap-3 px-4 py-2 text-sm hover:bg-surface-2"
            >
              <span class="w-5 shrink-0 text-right text-xs text-subtle tabular-nums">{i + 1}</span>
              <span class="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-2">
                <span class="shrink-0 font-mono text-xs text-muted">{t.key}</span>
                {#if titleOf.get(t.key)}
                  <span class="truncate">{titleOf.get(t.key)}</span>
                {/if}
              </span>
              <span class="shrink-0 text-right tabular-nums">
                <span class="font-medium text-text">{fmtUsdExact(t.usd)}</span>
                <span class="block text-xs text-subtle sm:ml-2 sm:inline">{fmtTurns(t.runs)}</span>
              </span>
            </a>
          </li>
        {/each}
      </ol>
    {/if}
  </section>

  <p class="text-xs text-subtle">
    {monthLabel}'s figure counts from the 1st; the range counts back from today. Both come from the
    same day rows, so they always agree.
  </p>
</div>

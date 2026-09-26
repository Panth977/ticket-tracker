<!--
  Account › Usage (agents.html §X, last two bullets) — WHAT THIS PROJECT COSTS.

  The admin's other module, beside Users: this month's estimated bill broken
  down by service, and — first, because it is the number that decides whether
  the month costs ₹0 or ₹600 — TODAY's reads and writes against the free daily
  quota.

  Everything here is one GET. The server does the sums and keeps the answer for
  an hour, so opening this page costs one document read; the sparklines are
  drawn from the daily series that came in the same response, so they cost
  nothing at all. "Refresh" is the only thing that asks Cloud Monitoring again,
  which is why it is a button and not a timer.

  It is an ESTIMATE and says so. The Firebase console remains the invoice.
-->
<script lang="ts">
  import { IndianRupee, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-svelte';
  import { USAGE_CAVEAT, type UsageLine } from '@tm/shared/api/usage';
  import { auth } from '$lib/firebase/auth.svelte';
  import { Button, EmptyState, Skeleton, toast } from '$lib/ui';
  import { ADMIN_EMAIL, amIAdmin } from '../allow';
  import { dateTime } from '../format';
  import SectionHeader from '../SectionHeader.svelte';
  import {
    amount,
    fetchUsage,
    hasShape,
    quotaFraction,
    quotaTone,
    resetsIn,
    rupees,
    sparkline,
    type UsageRes,
  } from '../usage';

  const admin = $derived(amIAdmin(auth.user?.email));

  let data = $state<UsageRes | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let loadError = $state(false);

  async function load(refresh = false) {
    if (refresh) refreshing = true;
    else loading = true;
    try {
      data = await fetchUsage(refresh);
      loadError = false;
      if (refresh && data.status === 'ok') toast.success('Usage refreshed');
    } catch {
      loadError = true;
      if (refresh) toast.error('Could not refresh usage');
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  $effect(() => {
    if (admin && loading && !loadError && !data) void load();
  });

  /** The two rows that matter today. Drawn before anything else on the page. */
  const todayBars = $derived(
    data
      ? [
          { label: 'Reads', used: data.today.reads, free: data.today.readsFree },
          { label: 'Writes', used: data.today.writes, free: data.today.writesFree },
        ]
      : [],
  );

  /** Lines grouped under their service, in the order the money went. */
  const grouped = $derived.by(() => {
    if (!data) return [] as { id: string; label: string; inr: number; lines: UsageLine[] }[];
    return data.estimate.services.map((s) => ({
      ...s,
      lines: data!.estimate.lines.filter((l) => l.service === s.id),
    }));
  });

  const monthLabel = $derived(
    data
      ? new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
          new Date(`${data.month}-02T12:00:00Z`),
        )
      : '',
  );

  const barClass = (tone: 'ok' | 'warn' | 'over') =>
    tone === 'over' ? 'bg-danger' : tone === 'warn' ? 'bg-warning' : 'bg-accent';
</script>

<SectionHeader
  title="Usage & cost"
  description="What this project is spending this month, estimated from list prices. Firebase's console is the invoice; this is here so you rarely have to open it."
>
  {#snippet actions()}
    {#if admin}
      <Button
        variant="ghost"
        icon={RefreshCw}
        loading={refreshing}
        disabled={loading}
        onclick={() => load(true)}>Refresh</Button
      >
    {/if}
  {/snippet}
</SectionHeader>

{#if !admin}
  <EmptyState
    icon={ShieldCheck}
    title="Only the admin sees what this costs"
    description="This is the project's bill, not a board. {ADMIN_EMAIL} owns it."
  />
{:else if loading}
  <div class="flex flex-col gap-3">
    <Skeleton height="6rem" />
    <Skeleton height="10rem" />
  </div>
{:else if loadError || !data}
  <EmptyState
    icon={IndianRupee}
    title="Could not load usage"
    description="Something went wrong reading what this project is costing."
  >
    {#snippet action()}<Button onclick={() => load()}>Try again</Button>{/snippet}
  </EmptyState>
{:else}
  {#if data.status !== 'ok' && data.message}
    <!--
      Never an error page (§X): the Monitoring grant is a one-line console step
      after the first deploy, so the panel explains itself and shows the command.
    -->
    <div
      class="mb-6 flex gap-3 rounded-xl border border-line bg-surface-2 p-4 text-sm"
      role="status"
    >
      <TriangleAlert size={18} class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
      <div class="min-w-0">
        <p class="font-medium">
          {#if data.status === 'notGranted'}
            Usage is not readable yet
          {:else if data.status === 'local'}
            Nothing to measure here
          {:else}
            Usage could not be read just now
          {/if}
        </p>
        <pre
          class="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-muted">{data.message}</pre>
        {#if data.stale}
          <p class="mt-2 text-xs text-subtle">
            Showing the last numbers that were read, from {dateTime(
              data.measuredAt,
              auth.profile?.timezone,
            )}.
          </p>
        {/if}
      </div>
    </div>
  {/if}

  <!-- ── TODAY, against the free daily quota ── -->
  <section class="rounded-xl border border-line bg-surface p-4" aria-labelledby="usage-today">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h3 id="usage-today" class="text-sm font-semibold">Today, against the free daily quota</h3>
      <p class="text-xs text-subtle">
        {resetsIn(data.today.resetsAt)} · the quota day runs on US Pacific time
      </p>
    </div>
    <p class="mt-1 max-w-prose text-xs text-muted">
      This is the number that decides whether the month costs nothing or a lot: the daily allowance
      does not roll over, so one heavy day is charged even if the month looks quiet.
    </p>
    <ul class="mt-4 flex flex-col gap-3">
      {#each todayBars as bar (bar.label)}
        {@const tone = quotaTone(bar.used, bar.free)}
        {@const pct = Math.min(100, Math.round(quotaFraction(bar.used, bar.free) * 100))}
        <li>
          <div class="flex items-baseline justify-between gap-2 text-sm">
            <span class="font-medium">{bar.label}</span>
            <span class:text-danger={tone === 'over'} class="tabular-nums">
              {bar.used.toLocaleString('en-IN')} / {bar.free.toLocaleString('en-IN')}
            </span>
          </div>
          <div
            class="mt-1 h-2 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-label="{bar.label} used today"
            aria-valuenow={bar.used}
            aria-valuemin={0}
            aria-valuemax={bar.free}
          >
            <div class="h-full rounded-full {barClass(tone)}" style="width: {pct}%"></div>
          </div>
          {#if tone === 'over'}
            <p class="mt-1 text-xs text-danger">
              Past the free allowance — every {bar.label.toLowerCase().slice(0, -1)} beyond it is billed.
            </p>
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  <!-- ── THIS MONTH, broken down by service ── -->
  <section class="mt-6" aria-labelledby="usage-month">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h3 id="usage-month" class="text-sm font-semibold">{monthLabel} so far</h3>
        <p class="text-xs text-subtle">
          {data.days.length}
          {data.days.length === 1 ? 'day' : 'days'} · prices as of {data.prices.asOf} for {data
            .prices.region} · ₹{data.prices.usdToInr} to the dollar
        </p>
      </div>
      <p class="text-3xl font-semibold tabular-nums">{rupees(data.estimate.totalInr)}</p>
    </div>

    <div class="mt-4 flex flex-col gap-4">
      {#each grouped as service (service.id)}
        <div class="rounded-xl border border-line bg-surface">
          <div
            class="flex items-baseline justify-between gap-2 border-b border-line px-4 py-3 text-sm"
          >
            <span class="font-medium">{service.label}</span>
            <span class="tabular-nums">{rupees(service.inr)}</span>
          </div>
          <ul>
            {#each service.lines as l (l.id)}
              <li
                class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-b-0"
              >
                <div class="min-w-40 flex-1">
                  <p class="font-medium">{l.label}</p>
                  <p class="text-xs text-subtle">
                    {amount(l.used, l.unit)} used · {amount(l.free, l.unit)} free ({l.quota ===
                    'daily'
                      ? 'daily'
                      : 'monthly'}) · {l.rate}
                  </p>
                </div>
                {#if hasShape(l.series)}
                  <!-- Free: the daily values are what the total was summed from. -->
                  <svg
                    class="h-6 w-24 shrink-0 text-muted"
                    viewBox="0 0 100 24"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <polyline
                      points={sparkline(l.series)}
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      vector-effect="non-scaling-stroke"
                    />
                  </svg>
                {:else}
                  <span class="h-6 w-24 shrink-0" aria-hidden="true"></span>
                {/if}
                <span class="w-20 shrink-0 text-right tabular-nums">{rupees(l.inr)}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </div>

    <p class="mt-4 max-w-prose text-xs text-subtle">
      {USAGE_CAVEAT}
      {#if data.status === 'ok'}
        Measured {dateTime(data.measuredAt, auth.profile?.timezone)}{#if data.cached}, from the
          hourly cache{/if}.
      {/if}
    </p>
  </section>
{/if}

<!--
  THE TURN RECEIPT (docs/plan/agents.html §Y1) — a message with `run` is not a
  bubble; it is one compact row the thread can read at a glance:

    🧾 Turn 3 · review · $1.24 · 12 min · 46 calls · fable-5-1      Builder · 10:42

  The outcome word is the only coloured thing (review green, waiting amber,
  blocked / failed / timeout red, stopped muted). The session's running total
  and the tokens are in the row's tooltip, not on the line.
-->
<script lang="ts">
  import { Receipt } from 'lucide-svelte';
  import type { RunReceipt } from '@tm/shared';
  import { fmtCalls, fmtDuration, fmtUsage, fmtUsdExact, outcomeClass, shortModel } from './format';

  interface Props {
    run: RunReceipt;
    /** Who posted it (the orchestrator's agent) and when — kept small. */
    authorName: string;
    /** '10:42' — already in the viewer's zone. */
    time: string;
    /** Full timestamp for the tooltip. */
    timeTitle?: string;
    class?: string;
  }
  let { run, authorName, time, timeTitle, class: cls = '' }: Props = $props();

  const parts = $derived(
    [
      fmtUsdExact(run.costUsd),
      fmtDuration(run.durationMs),
      fmtCalls(run.apiTurns),
      shortModel(run.model),
    ].filter((p): p is string => !!p),
  );
  const details = $derived(
    [
      run.sessionUsd != null ? `Session so far ${fmtUsdExact(run.sessionUsd)}` : null,
      fmtUsage(run.usage),
      run.model,
    ]
      .filter(Boolean)
      .join(' · '),
  );
</script>

<div
  class="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs {cls}"
  data-receipt={run.n}
  title={details || undefined}
>
  <Receipt size={13} class="shrink-0 text-subtle" aria-hidden="true" />
  <span class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 tabular-nums">
    <span class="font-medium text-text">Turn {run.n}</span>
    <span class="text-subtle" aria-hidden="true">·</span>
    <span class="font-medium {outcomeClass(run.outcome)}" data-outcome={run.outcome}
      >{run.outcome}</span
    >
    {#each parts as p (p)}
      <span class="text-subtle" aria-hidden="true">·</span>
      <span class="text-muted">{p}</span>
    {/each}
  </span>
  <span class="ml-auto flex shrink-0 items-baseline gap-1 text-[11px] text-subtle">
    <span class="max-w-32 truncate">{authorName}</span>
    <span aria-hidden="true">·</span>
    <time title={timeTitle}>{time}</time>
  </span>
</div>

<!--
  AN 'agg' MESSAGE (docs/plan/aggregates.html) — entries added to the board's
  aggregate fields, drawn like a turn receipt: one compact row, never a bubble.

    Σ  +2.5 h Time · −$0.40 Cost   “Pairing on the parser”      Ada · 10:42

  It is never edited or deleted (a correction is another entry), so it has no
  menu. A note the person wrote goes after the entries; the summary the server
  writes when there was no note is not repeated.
-->
<script lang="ts">
  import { Sigma } from 'lucide-svelte';
  import { formatAggEntry, type AggFieldDef, type MessageAgg } from '@tm/shared';

  interface Props {
    agg: MessageAgg;
    /** The board's fields, archived ones too (an old entry still has a name). */
    fields: readonly AggFieldDef[];
    /** The message's text; shown when it is more than the entries spelled out. */
    note?: string | null;
    authorName: string;
    time: string;
    timeTitle?: string;
    /** On its way (the outbox): faded; failed: the parent draws Resend. */
    pending?: boolean;
    class?: string;
  }
  let {
    agg,
    fields,
    note = null,
    authorName,
    time,
    timeTitle,
    pending = false,
    class: cls = '',
  }: Props = $props();

  const byId = $derived(new Map(fields.map((f) => [f.id, f])));
  const parts = $derived(
    agg.entries.map((e) => {
      const f = byId.get(e.fieldId);
      return {
        id: e.fieldId,
        text: f
          ? formatAggEntry(e.value, f)
          : `${e.value < 0 ? '−' : '+'}${Math.abs(e.value)} (removed field)`,
        negative: e.value < 0,
      };
    }),
  );
  const summary = $derived(parts.map((p) => p.text).join(' · '));
  const extra = $derived(note && note.trim() && note.trim() !== summary ? note.trim() : null);
</script>

<div
  class="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs {pending
    ? 'opacity-60'
    : ''} {cls}"
  data-agg-card
  aria-label="{authorName} added {summary}"
>
  <Sigma size={13} class="shrink-0 text-subtle" aria-hidden="true" />
  <span class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 tabular-nums">
    {#each parts as p, i (p.id)}
      {#if i}<span class="text-subtle" aria-hidden="true">·</span>{/if}
      <span class="font-medium {p.negative ? 'text-muted' : 'text-text'}" data-agg-entry={p.id}
        >{p.text}</span
      >
    {/each}
    {#if extra}
      <span class="text-subtle" aria-hidden="true">—</span>
      <span class="min-w-0 break-words text-muted" data-agg-note>{extra}</span>
    {/if}
  </span>
  <span class="ml-auto flex shrink-0 items-baseline gap-1 text-[11px] text-subtle">
    <span class="max-w-32 truncate">{authorName}</span>
    <span aria-hidden="true">·</span>
    <time title={timeTitle}>{time}</time>
  </span>
</div>

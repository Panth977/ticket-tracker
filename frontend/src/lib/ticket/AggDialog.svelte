<!--
  ADD TO A TOTAL (docs/plan/aggregates.html) — the composer's Σ button and
  /agg. One row per active aggregate field of the board: a number (negative
  takes away; blank skips the field) and an optional note. Posts ONE 'agg'
  message through the outbox — the row shows in the thread at once and the
  ticket's and the board's totals move when it lands.
-->
<script lang="ts">
  import { aggAtFrom, formatAgg, formatAggEntry, type RichTextDoc } from '@tm/shared';
  import { auth } from '$lib/firebase/auth.svelte';
  import { Button, Dialog, Input, Textarea } from '$lib/ui';
  import {
    activeAggFields,
    aggCountersOf,
    draftEntries,
    parseAggValue,
  } from '$lib/aggregates/fields';
  import { getTicketCtx } from './context';
  import { sendAgg } from './pending.svelte';

  interface Props {
    open: boolean;
    onsent?: (messageId: string) => void;
  }
  let { open = $bindable(false), onsent }: Props = $props();

  const t = getTicketCtx();
  const fields = $derived(activeAggFields(t.board));
  const totals = $derived(aggCountersOf(t.ticket));

  let raw = $state<Record<string, string>>({});
  let note = $state('');
  let touched = $state(false);
  /** The day the entries are FOR (aggregates.html): today, or a past day being backfilled. */
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  let forDay = $state(today());
  $effect(() => {
    if (open) {
      raw = {};
      note = '';
      touched = false;
      forDay = today();
    }
  });
  const forProblem = $derived(
    !/^\d{4}-\d{2}-\d{2}$/.test(forDay)
      ? 'Pick a day'
      : forDay > today()
        ? 'Not in the future'
        : null,
  );

  const check = $derived(
    draftEntries(fields.map((f) => ({ fieldId: f.id, raw: raw[f.id] ?? '' }))),
  );
  const preview = $derived(
    check.entries
      .map((e) => {
        const f = fields.find((x) => x.id === e.fieldId);
        return f ? formatAggEntry(e.value, f) : '';
      })
      .join(' · '),
  );

  /** The note as a one-paragraph-per-line doc; '' → an empty doc (the server writes the entries out). */
  function noteDoc(text: string): RichTextDoc {
    const lines = text.trim() ? text.trim().split(/\n+/) : [];
    return {
      type: 'doc',
      content: lines.map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] })),
    } as RichTextDoc;
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    touched = true;
    if (!check.ok || forProblem) return;
    // Today: no date (counted when posted). A past day: that day's bucket.
    const at = forDay === today() ? null : aggAtFrom(forDay);
    const id = sendAgg({
      boardId: t.boardId,
      ticketId: t.ticketId,
      ticketKey: t.ticket.key,
      authorUid: t.me,
      authorName: auth.profile?.name || auth.user?.displayName || 'You',
      agg: at !== null ? { at, entries: check.entries } : { entries: check.entries },
      body: noteDoc(note),
    });
    open = false;
    onsent?.(id);
  }
</script>

<Dialog bind:open title="Add to a total" size="sm">
  <form id="agg-dialog" class="flex flex-col gap-3" onsubmit={submit} data-agg-dialog>
    <p class="text-xs text-muted">
      Each number is added to this ticket's total and the board's. A negative number takes away. It
      can't be edited later — a correction is another entry.
    </p>
    {#each fields as f, i (f.id)}
      {@const cur = totals[f.id]}
      {@const v = parseAggValue(raw[f.id] ?? '')}
      <Input
        label="{f.label}{f.unit ? ` (${f.unit})` : ''}"
        inputmode="decimal"
        autocomplete="off"
        value={raw[f.id] ?? ''}
        autofocus={i === 0}
        placeholder="0"
        error={(touched || (v !== null && Number.isNaN(v))) && check.errors[f.id]
          ? check.errors[f.id]
          : null}
        hint={cur && cur.count > 0
          ? `This ticket so far: ${formatAgg(cur.total, f.unit)}`
          : undefined}
        oninput={(e) => (raw = { ...raw, [f.id]: e.currentTarget.value })}
        data-agg-input={f.id}
      />
    {/each}
    <Input
      label="For"
      type="date"
      value={forDay}
      max={today()}
      error={forProblem}
      hint={forDay !== today() ? "Counts in that day's (week's, month's) total" : undefined}
      oninput={(e) => (forDay = e.currentTarget.value)}
      data-agg-for
    />
    <Textarea
      label="Note (optional)"
      value={note}
      rows={2}
      maxlength={2000}
      oninput={(e) => (note = e.currentTarget.value)}
    />
    {#if touched && !check.entries.length && !Object.keys(check.errors).length}
      <p class="text-xs text-danger">Enter a number for at least one field.</p>
    {/if}
  </form>
  {#snippet footer()}
    {#if preview}<span class="mr-auto truncate text-xs text-muted tabular-nums">{preview}</span
      >{/if}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" type="submit" form="agg-dialog" disabled={touched && !check.ok}
      >Add</Button
    >
  {/snippet}
</Dialog>

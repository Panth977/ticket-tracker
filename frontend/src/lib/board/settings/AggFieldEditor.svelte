<!--
  Aggregate field editor (docs/plan/aggregates.html): Label · Unit · Period ·
  Show on card. The period is fixed once the field has entries — its buckets
  were cut by it (the server refuses the change too). Hands the finished
  AggFieldDef back; the Aggregates section saves the list.
-->
<script lang="ts">
  import { AGG_PERIODS, type AggFieldDef, type AggPeriod } from '@tm/shared';
  import Button from '$lib/ui/Button.svelte';
  import Checkbox from '$lib/ui/Checkbox.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';
  import { PERIOD_LABEL } from '$lib/aggregates/periods';

  interface Props {
    open: boolean;
    field: AggFieldDef | null;
    isNew: boolean;
    /** Other fields' labels (lower-cased) — labels must be unique. */
    taken: string[];
    /** The field has entries: its period can't change. */
    locked: boolean;
    onsubmit: (def: AggFieldDef) => void;
  }
  let { open = $bindable(false), field, isNew, taken, locked, onsubmit }: Props = $props();

  let f = $state<AggFieldDef | null>(null);
  $effect(() => {
    if (open && field) f = JSON.parse(JSON.stringify(field)) as AggFieldDef;
  });

  const labelTaken = $derived(!!f && taken.includes(f.label.trim().toLowerCase()));
  const valid = $derived(
    !!f &&
      f.label.trim().length > 0 &&
      f.label.trim().length <= 40 &&
      !labelTaken &&
      f.unit.trim().length <= 12,
  );

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!f || !valid) return;
    const def: AggFieldDef = { ...f, label: f.label.trim(), unit: f.unit.trim() };
    if (!def.showOnCard) delete def.showOnCard;
    onsubmit(def);
    open = false;
  }
</script>

<Dialog bind:open title={isNew ? 'New aggregate field' : `Edit “${field?.label ?? ''}”`} size="md">
  {#if f}
    <form id="agg-field-editor" class="flex flex-col gap-4" onsubmit={submit}>
      <Input
        label="Label"
        value={f.label}
        maxlength={40}
        required
        autofocus
        placeholder="Time, Cost, Points…"
        error={labelTaken ? 'Another field already has this label' : null}
        oninput={(e) => (f = { ...f!, label: e.currentTarget.value })}
      />
      <Input
        label="Unit"
        value={f.unit}
        maxlength={12}
        class="w-40"
        placeholder="$, h, km, pts"
        hint="Currency symbols go before the number ($1.24); anything else after it (2.5 h). Leave empty for a plain count."
        oninput={(e) => (f = { ...f!, unit: e.currentTarget.value })}
      />
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Period</span>
        <select
          class="h-9 w-40 rounded-md border border-line bg-surface px-2 disabled:opacity-70"
          value={f.period}
          disabled={locked}
          aria-label="Period"
          onchange={(e) => (f = { ...f!, period: e.currentTarget.value as AggPeriod })}
        >
          {#each AGG_PERIODS as p (p)}<option value={p}>{PERIOD_LABEL[p]}</option>{/each}
        </select>
        <span class="text-xs text-muted">
          {locked
            ? "The period can't change once the field has entries — its totals were bucketed by it. Make a new field instead."
            : 'How Analytics buckets the totals: per day, per ISO week or per month.'}
        </span>
      </label>
      <Checkbox
        label="Show on card"
        description="A ticket's total shows as a chip on its card, and the board's total on the board bar."
        checked={f.showOnCard ?? false}
        onchange={(e) => (f = { ...f!, showOnCard: e.currentTarget.checked })}
      />
    </form>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" type="submit" form="agg-field-editor" disabled={!valid}
      >{isNew ? 'Add field' : 'Done'}</Button
    >
  {/snippet}
</Dialog>

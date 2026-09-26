<!--
  The operand editor of one filter condition — chosen by the field's kind:
  options (stage / priority / tags / select / state), people (with the 'me'
  token), dates (today / this week / overdue tokens or a day), numbers, text.
-->
<script lang="ts">
  import type { Cmp } from '@tm/shared';
  import ChoicePicker, { type ChoiceItem } from './pickers/ChoicePicker.svelte';
  import { STATE_OPTIONS, type FieldInfo } from './fields';

  interface Props {
    info: FieldInfo;
    cmp: Cmp;
    value: unknown;
    people: { uid: string; name: string; email: string }[];
    onchange: (value: unknown) => void;
  }
  let { info, cmp, value, people, onchange }: Props = $props();

  const DATE_TOKENS = [
    { id: 'today', label: 'Today' },
    { id: 'thisWeek', label: 'This week' },
    { id: 'overdue', label: 'Overdue' },
  ];

  const asList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)];

  const optionItems = $derived.by((): ChoiceItem[] => {
    if (info.kind === 'state') return STATE_OPTIONS.map((o) => ({ id: o.id, label: o.name }));
    return (info.options ?? []).map((o) => ({ id: o.id, label: o.name, color: o.color }));
  });
  const peopleItems = $derived<ChoiceItem[]>([
    { id: 'me', label: 'Me (whoever is looking)' },
    ...people.map((p) => ({ id: p.uid, label: p.name, uid: p.uid, search: p.email })),
  ]);

  const isOptions = $derived(
    ['stage', 'priority', 'tags', 'select', 'multiSelect', 'state'].includes(info.kind),
  );
  const isPeople = $derived(['assignees', 'people', 'person'].includes(info.kind));
  const pair = $derived(
    Array.isArray(value) && cmp === 'between' ? (value as unknown[]) : [value, value],
  );

  /** A date operand is a token or a 'YYYY-MM-DD' day string (the engine reads both). */
  function dateKind(v: unknown): string {
    return typeof v === 'string' && DATE_TOKENS.some((t) => t.id === v) ? v : 'day';
  }
  const today = () => new Date().toISOString().slice(0, 10);
</script>

{#snippet dateInput(v: unknown, set: (v: unknown) => void)}
  <span class="inline-flex items-center gap-1">
    <select
      class="h-7 rounded-md border border-line bg-surface px-1.5 text-xs"
      aria-label="Date"
      value={dateKind(v)}
      onchange={(e) => {
        const k = e.currentTarget.value;
        set(k === 'day' ? today() : k);
      }}
    >
      {#each DATE_TOKENS as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
      <option value="day">A day…</option>
    </select>
    {#if dateKind(v) === 'day'}
      <input
        type="date"
        class="h-7 rounded-md border border-line bg-surface px-1.5 text-xs"
        aria-label="Day"
        value={typeof v === 'string' ? v.slice(0, 10) : ''}
        onchange={(e) => set(e.currentTarget.value || today())}
      />
    {/if}
  </span>
{/snippet}

{#if cmp === 'empty' || cmp === 'notEmpty'}
  <!-- no operand -->
{:else if isOptions}
  <ChoicePicker
    items={optionItems}
    selected={asList(value)}
    multi
    label="{info.label} values"
    placeholder="Any of…"
    onchange={(ids) => onchange(ids)}
  />
{:else if isPeople}
  <ChoicePicker
    items={peopleItems}
    selected={asList(value)}
    multi
    label="People"
    placeholder="Anyone…"
    onchange={(ids) => onchange(ids)}
  />
{:else if info.kind === 'date'}
  {#if cmp === 'between'}
    {@render dateInput(pair[0], (v) => onchange([v, pair[1]]))}
    <span class="text-xs text-muted">and</span>
    {@render dateInput(pair[1], (v) => onchange([pair[0], v]))}
  {:else}
    {@render dateInput(value, onchange)}
  {/if}
{:else if info.kind === 'number' || info.kind === 'readonly'}
  {#if cmp === 'between'}
    <input
      type="number"
      aria-label="From"
      class="h-7 w-20 rounded-md border border-line bg-surface px-1.5 text-xs"
      value={Number(pair[0] ?? 0)}
      onchange={(e) => onchange([Number(e.currentTarget.value), pair[1]])}
    />
    <span class="text-xs text-muted">and</span>
    <input
      type="number"
      aria-label="To"
      class="h-7 w-20 rounded-md border border-line bg-surface px-1.5 text-xs"
      value={Number(pair[1] ?? 0)}
      onchange={(e) => onchange([pair[0], Number(e.currentTarget.value)])}
    />
  {:else}
    <input
      type="number"
      aria-label="Value"
      class="h-7 w-24 rounded-md border border-line bg-surface px-1.5 text-xs"
      value={Number(value ?? 0)}
      onchange={(e) => onchange(Number(e.currentTarget.value))}
    />
  {/if}
{:else}
  <input
    type="text"
    aria-label="Value"
    class="h-7 w-40 rounded-md border border-line bg-surface px-1.5 text-xs"
    value={typeof value === 'string' ? value : ''}
    oninput={(e) => onchange(e.currentTarget.value)}
  />
{/if}

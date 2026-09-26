<!--
  An editor for one custom field value, per FieldType. Used by table cells,
  the requires prompt and the full new-ticket form. Emits the value exactly as
  ticketUpdate / ticketCreate store it (FieldValue): option ids, uids, Millis,
  { start, end }; null clears.
-->
<script lang="ts">
  import { Star } from 'lucide-svelte';
  import type { FieldDef, FieldValue } from '@tm/shared';
  import DatePicker from '$lib/ui/DatePicker.svelte';
  import ChoicePicker, { type ChoiceItem } from '$lib/views/pickers/ChoicePicker.svelte';
  import { useBoard } from './context.svelte';

  interface Props {
    def: FieldDef;
    value: FieldValue | undefined;
    onchange: (value: FieldValue) => void;
    /** Open pickers immediately (inline cell editing). */
    autofocus?: boolean;
    onclose?: () => void;
    id?: string;
  }
  let { def, value, onchange, autofocus = false, onclose, id }: Props = $props();
  const bs = useBoard();

  const options = $derived<ChoiceItem[]>(
    [...(def.options ?? [])]
      .sort((a, b) => a.position - b.position)
      .map((o) => ({ id: o.id, label: o.name, color: o.color })),
  );
  const peopleItems = $derived<ChoiceItem[]>(bs.peopleChoices);
  const ticketItems = $derived<ChoiceItem[]>(
    bs.tickets.map((t) => ({ id: t.id, label: `${t.key} · ${t.title}`, search: t.key })),
  );
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? (v as string[]) : typeof v === 'string' && v ? [v] : [];
  const range = $derived(
    value && typeof value === 'object' && !Array.isArray(value) ? value : null,
  );

  function text(e: Event & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) {
    const v = e.currentTarget.value;
    onchange(v === '' ? null : v);
  }
  function num(e: Event & { currentTarget: HTMLInputElement }) {
    const v = e.currentTarget.value;
    onchange(v === '' ? null : Number(v));
  }
  const inputCls =
    'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm outline-none focus:border-accent';
  const focus = (node: HTMLElement) => {
    if (autofocus) queueMicrotask(() => node.focus());
  };
</script>

{#if def.type === 'select'}
  <ChoicePicker
    items={options}
    selected={list(value)}
    allowNone
    label={def.name}
    placeholder="—"
    autoOpen={autofocus}
    {onclose}
    onchange={(ids) => onchange(ids[0] ?? null)}
  />
{:else if def.type === 'multiSelect'}
  <ChoicePicker
    items={options}
    selected={list(value)}
    multi
    label={def.name}
    placeholder="—"
    autoOpen={autofocus}
    {onclose}
    onchange={(ids) => onchange(ids)}
  />
{:else if def.type === 'person'}
  <ChoicePicker
    items={peopleItems}
    selected={list(value)}
    allowNone
    label={def.name}
    placeholder="—"
    autoOpen={autofocus}
    {onclose}
    onchange={(ids) => onchange(ids[0] ?? null)}
  />
{:else if def.type === 'people'}
  <ChoicePicker
    items={peopleItems}
    selected={list(value)}
    multi
    label={def.name}
    placeholder="—"
    autoOpen={autofocus}
    {onclose}
    onchange={(ids) => onchange(ids)}
  />
{:else if def.type === 'ticketRelation'}
  <ChoicePicker
    items={ticketItems}
    selected={list(value)}
    multi
    label={def.name}
    placeholder="—"
    autoOpen={autofocus}
    {onclose}
    onchange={(ids) => onchange(ids)}
  />
{:else if def.type === 'checkbox'}
  <input
    {id}
    type="checkbox"
    class="size-4 accent-[var(--tm-accent)]"
    checked={value === true}
    aria-label={def.name}
    onchange={(e) => onchange(e.currentTarget.checked)}
    use:focus
  />
{:else if def.type === 'date'}
  <DatePicker
    value={typeof value === 'number' ? value : null}
    withTime={false}
    tz={bs.tz}
    label={def.name}
    onchange={(v) => onchange(v)}
  />
{:else if def.type === 'dateRange'}
  <span class="flex items-center gap-1">
    <DatePicker
      value={range?.start ?? null}
      withTime={false}
      tz={bs.tz}
      label="{def.name} start"
      onchange={(v) => onchange(v == null ? null : { start: v, end: Math.max(v, range?.end ?? v) })}
    />
    <span class="text-xs text-muted">→</span>
    <DatePicker
      value={range?.end ?? null}
      withTime={false}
      tz={bs.tz}
      label="{def.name} end"
      onchange={(v) =>
        onchange(v == null ? null : { start: Math.min(v, range?.start ?? v), end: v })}
    />
  </span>
{:else if def.type === 'rating'}
  {@const max = def.config?.max ?? 5}
  <span class="flex items-center" role="radiogroup" aria-label={def.name}>
    {#each Array.from({ length: max }, (_, i) => i + 1) as n (n)}
      <button
        type="button"
        role="radio"
        aria-checked={value === n}
        aria-label="{n} of {max}"
        class="p-0.5 text-warning"
        onclick={() => onchange(value === n ? null : n)}
      >
        <Star
          size={14}
          class={typeof value === 'number' && n <= value ? 'fill-current' : 'opacity-40'}
        />
      </button>
    {/each}
  </span>
{:else if def.type === 'number' || def.type === 'currency' || def.type === 'percent'}
  <input
    {id}
    type="number"
    step="any"
    class={inputCls}
    value={typeof value === 'number' ? value : ''}
    aria-label={def.name}
    onchange={num}
    use:focus
    onblur={() => onclose?.()}
  />
{:else if def.type === 'longText'}
  <textarea
    {id}
    rows="3"
    class="w-full rounded-md border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-accent"
    value={typeof value === 'string' ? value : ''}
    aria-label={def.name}
    onchange={text}
    use:focus
    onblur={() => onclose?.()}></textarea>
{:else if def.type === 'formula'}
  <span class="text-sm text-muted">{value ?? '—'}</span>
{:else}
  <input
    {id}
    type={def.type === 'url'
      ? 'url'
      : def.type === 'email'
        ? 'email'
        : def.type === 'phone'
          ? 'tel'
          : 'text'}
    class={inputCls}
    value={typeof value === 'string' ? value : ''}
    aria-label={def.name}
    onchange={text}
    use:focus
    onblur={() => onclose?.()}
  />
{/if}

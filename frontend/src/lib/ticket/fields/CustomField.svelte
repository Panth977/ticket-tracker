<!--
  One editor per custom FieldType (db.json FieldDef.type). Values are stored
  under the field's id; null clears. Text-like inputs commit on blur / Enter.
  <CustomField def={f} value={ticket.fields[f.id]} disabled={!canEdit} onchange={(v) => …} />
-->
<script lang="ts">
  // Ticket links come from ctx.ticketHref (lib/layout/routes); other hrefs are external. The SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { ExternalLink, Plus, Star } from 'lucide-svelte';
  import type { DateRange, FieldDef, FieldValue } from '@tm/shared';
  import { DatePicker } from '$lib/ui';
  import OptionPicker from './OptionPicker.svelte';
  import TicketChip from '../TicketChip.svelte';
  import TicketPicker from '../TicketPicker.svelte';
  import { getTicketCtx } from '../context';
  import { formatNumber, parseNumberInput } from './format';

  interface Props {
    def: FieldDef;
    value: FieldValue | undefined;
    disabled?: boolean;
    onchange: (v: FieldValue) => void;
  }
  let { def, value, disabled = false, onchange }: Props = $props();

  const t = getTicketCtx();
  const people = $derived(
    t.members.map((m) => ({ id: m.uid, uid: m.uid, name: m.name || m.email, detail: m.email })),
  );
  const opts = $derived(
    [...(def.options ?? [])]
      .sort((a, b) => a.position - b.position)
      .map((o) => ({ id: o.id, name: o.name, color: o.color })),
  );
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const str = (v: unknown) => (v == null || typeof v === 'object' ? '' : String(v));

  let draft = $state<string | null>(null);
  const shown = $derived(
    draft ??
      (typeof value === 'number' && ['number', 'currency', 'percent'].includes(def.type)
        ? String(value)
        : str(value)),
  );

  function commitText() {
    if (draft === null) return;
    const raw = draft.trim();
    draft = null;
    let next: FieldValue = raw || null;
    if (['number', 'currency', 'percent'].includes(def.type)) {
      if (!raw) next = null;
      else {
        const n = parseNumberInput(raw);
        if (n === null) return; // not a number: revert
        next = def.config?.precision != null ? Number(n.toFixed(def.config.precision)) : n;
      }
    }
    if (next !== (value ?? null)) onchange(next);
  }
  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !(e.currentTarget instanceof HTMLTextAreaElement && e.shiftKey)) {
      e.preventDefault();
      (e.currentTarget as HTMLElement).blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      draft = null;
      (e.currentTarget as HTMLElement).blur();
    }
  }

  const range = $derived(
    value && typeof value === 'object' && !Array.isArray(value) ? (value as DateRange) : null,
  );
  const inputCls =
    'h-8 w-full rounded-md border border-transparent bg-transparent px-2 text-sm hover:border-line focus:border-accent focus:bg-surface focus:outline-none disabled:hover:border-transparent placeholder:text-subtle';
  const href = $derived.by(() => {
    const v = str(value);
    if (!v) return null;
    if (def.type === 'url') return /^https?:\/\//i.test(v) ? v : null;
    if (def.type === 'email') return `mailto:${v}`;
    if (def.type === 'phone') return `tel:${v.replace(/[^\d+]/g, '')}`;
    return null;
  });
</script>

{#if def.type === 'select'}
  <OptionPicker
    label={def.name}
    options={opts}
    value={value ? [String(value)] : []}
    clearable
    {disabled}
    onchange={(ids) => onchange(ids[0] ?? null)}
  />
{:else if def.type === 'multiSelect'}
  <OptionPicker
    label={def.name}
    options={opts}
    value={list(value)}
    multiple
    {disabled}
    onchange={(ids) => onchange(ids.length ? ids : null)}
  />
{:else if def.type === 'person'}
  <OptionPicker
    label={def.name}
    options={people}
    value={value ? [String(value)] : []}
    clearable
    {disabled}
    onchange={(ids) => onchange(ids[0] ?? null)}
  />
{:else if def.type === 'people'}
  <OptionPicker
    label={def.name}
    options={people}
    value={list(value)}
    multiple
    {disabled}
    onchange={(ids) => onchange(ids.length ? ids : null)}
  />
{:else if def.type === 'checkbox'}
  <label class="flex h-8 items-center gap-2 px-2 text-sm">
    <input
      type="checkbox"
      class="size-4 accent-[var(--tm-accent)]"
      checked={value === true}
      {disabled}
      onchange={(e) => onchange(e.currentTarget.checked)}
    />
    <span class="text-muted">{value === true ? 'Yes' : 'No'}</span>
  </label>
{:else if def.type === 'rating'}
  {@const max = def.config?.max ?? 5}
  {@const n = typeof value === 'number' ? value : 0}
  <div class="flex h-8 items-center gap-0.5 px-1.5" role="radiogroup" aria-label={def.name}>
    {#each Array.from({ length: max }, (_, i) => i + 1) as i (i)}
      <button
        type="button"
        role="radio"
        aria-checked={n === i}
        aria-label="{i} of {max}"
        {disabled}
        onclick={() => onchange(n === i ? null : i)}
        class="rounded p-0.5 {i <= n
          ? 'text-warning'
          : 'text-line-strong'} enabled:hover:text-warning"
      >
        <Star size={15} fill={i <= n ? 'currentColor' : 'none'} />
      </button>
    {/each}
  </div>
{:else if def.type === 'date'}
  <DatePicker
    value={typeof value === 'number' ? value : null}
    tz={t.tz}
    withTime={false}
    {disabled}
    onchange={(v) => onchange(v)}
  />
{:else if def.type === 'dateRange'}
  <div class="flex flex-col gap-1">
    <DatePicker
      value={range?.start ?? null}
      tz={t.tz}
      withTime={false}
      placeholder="Start"
      {disabled}
      onchange={(v) => onchange(v == null ? null : { start: v, end: Math.max(v, range?.end ?? v) })}
    />
    <DatePicker
      value={range?.end ?? null}
      tz={t.tz}
      withTime={false}
      placeholder="End"
      {disabled}
      onchange={(v) =>
        onchange(v == null ? null : { start: Math.min(v, range?.start ?? v), end: v })}
    />
  </div>
{:else if def.type === 'ticketRelation'}
  <div class="flex flex-col items-start gap-1 px-1">
    {#each list(value) as id (id)}
      <TicketChip
        ticketId={id}
        onremove={disabled
          ? undefined
          : () => {
              const rest = list(value).filter((x) => x !== id);
              onchange(rest.length ? rest : null);
            }}
      />
    {/each}
    {#if !disabled}
      <TicketPicker
        label="Add {def.name}"
        exclude={list(value)}
        onpick={(h) => onchange([...list(value), h.ticketId])}
      >
        {#snippet trigger(p)}
          <button
            type="button"
            {...p}
            class="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
          >
            <Plus size={12} /> Add
          </button>
        {/snippet}
      </TicketPicker>
    {:else if !list(value).length}<span class="px-1 text-sm text-subtle">None</span>{/if}
  </div>
{:else if def.type === 'formula'}
  <div class="flex h-8 items-center px-2 text-sm text-muted" title="Computed">
    {value == null ? '—' : typeof value === 'number' ? formatNumber(value, def) : str(value)}
  </div>
{:else if def.type === 'longText'}
  <textarea
    rows="2"
    value={shown}
    {disabled}
    aria-label={def.name}
    placeholder="Empty"
    oninput={(e) => (draft = e.currentTarget.value)}
    onblur={commitText}
    {onkeydown}
    class="{inputCls} h-auto min-h-8 resize-y py-1.5"></textarea>
{:else}
  {@const numeric = ['number', 'currency', 'percent'].includes(def.type)}
  <div class="relative flex items-center">
    {#if def.type === 'currency' && def.config?.currency}<span
        class="pointer-events-none absolute left-2 text-xs text-subtle">{def.config.currency}</span
      >{/if}
    <input
      type={def.type === 'email'
        ? 'email'
        : def.type === 'url'
          ? 'url'
          : def.type === 'phone'
            ? 'tel'
            : 'text'}
      inputmode={numeric ? 'decimal' : undefined}
      value={shown}
      {disabled}
      aria-label={def.name}
      placeholder="Empty"
      oninput={(e) => (draft = e.currentTarget.value)}
      onblur={commitText}
      {onkeydown}
      class="{inputCls} {def.type === 'currency' && def.config?.currency
        ? 'pl-10'
        : ''} {def.type === 'percent' ? 'pr-6' : ''}"
    />
    {#if def.type === 'percent'}<span
        class="pointer-events-none absolute right-2 text-xs text-subtle">%</span
      >{/if}
    {#if href && draft === null}
      <a
        {href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open {def.name}"
        class="absolute right-1 rounded p-1 text-subtle hover:text-accent"
        ><ExternalLink size={13} /></a
      >
    {/if}
  </div>
{/if}

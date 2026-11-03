<!--
  The board script's controls (docs/plan/board-script.html §2), drawn by the
  app: ui.text / longText / number / toggle / select / multiSelect / people /
  date / dateRange / note. Used in a ticket's Details pane (layout 'pane') and
  in the board's Filter popover (layout 'bar').

  Text and numbers change on blur or Enter, never per key; everything else on
  pick. A people control with `commitments` shows each person's commitment
  date (written straight to ticket.commitments, not through the script).
-->
<script lang="ts">
  import { X } from 'lucide-svelte';
  import type { ScriptControl } from '@tm/shared';
  import { Checkbox, DatePicker } from '$lib/ui';
  import { renderMarkdown } from '$lib/editor/markdown';
  import OptionPicker, { type PickOption } from '$lib/ticket/fields/OptionPicker.svelte';
  import PersonAvatar from '$lib/ticket/PersonAvatar.svelte';

  interface Props {
    controls: ScriptControl[];
    /** Everyone a people control may offer (the board's members). */
    people: PickOption[];
    tz?: string | null;
    /** Nothing editable (no edit permission). */
    disabled?: boolean;
    layout?: 'pane' | 'bar';
    commitments?: Record<string, number | null>;
    oncommit?: (uid: string, at: number | null) => void;
    onchange: (c: { id: string; value: unknown; allDay?: boolean }) => void;
  }
  let {
    controls,
    people,
    tz = null,
    disabled = false,
    layout = 'pane',
    commitments = {},
    oncommit,
    onchange,
  }: Props = $props();

  const shown = $derived(controls.filter((c) => !c.hidden));
  /** Text being typed, per control id; committed on blur / Enter. */
  let drafts = $state<Record<string, string>>({});

  const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const list = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string')
      : typeof v === 'string' && v
        ? [v]
        : [];
  const opts = (c: ScriptControl): PickOption[] =>
    (c.options ?? []).map((o) => ({ id: o.value, name: o.label, color: o.color ?? null }));
  const peopleOf = (c: ScriptControl): PickOption[] => {
    const want = c.people ? new Set(c.people) : null;
    const base = want ? people.filter((p) => want.has(p.id)) : people;
    // Someone already chosen but no longer offered still shows.
    const have = new Set(base.map((p) => p.id));
    const extra = list(c.value)
      .filter((id) => !have.has(id))
      .map((id) => people.find((p) => p.id === id) ?? { id, uid: id, name: 'Not on this board' });
    return [...base, ...extra];
  };
  const off = (c: ScriptControl) => disabled || !!c.disabled;

  function commitText(c: ScriptControl, kind: 'text' | 'number') {
    const id = c.id!;
    const raw = drafts[id];
    if (raw === undefined) return;
    delete drafts[id];
    if (kind === 'text') {
      if (raw !== str(c.value)) onchange({ id, value: raw });
      return;
    }
    const t = raw.trim();
    const n = t === '' ? null : Number(t.replace(',', '.'));
    if (n !== null && !Number.isFinite(n)) return;
    if (n !== (typeof c.value === 'number' ? c.value : null)) onchange({ id, value: n });
  }
  function keys(e: KeyboardEvent, c: ScriptControl, multiline = false) {
    if (e.key === 'Escape') {
      delete drafts[c.id!];
      (e.currentTarget as HTMLElement).blur();
    } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      (e.currentTarget as HTMLElement).blur();
    }
  }
  const inputCls =
    'w-full rounded-md border border-transparent bg-transparent px-2 text-sm hover:border-line focus:border-accent focus:bg-surface focus:outline-none disabled:hover:border-transparent';
</script>

{#snippet control(c: ScriptControl)}
  {#if c.type === 'note'}
    <div
      class="prose-sm text-sm {c.tone === 'danger'
        ? 'text-danger'
        : c.tone === 'warning'
          ? 'text-warning'
          : c.tone === 'success'
            ? 'text-success'
            : 'text-muted'}"
    >
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown sanitises -->
      {@html renderMarkdown(c.text ?? '').html}
    </div>
  {:else if c.type === 'text'}
    <input
      type="text"
      aria-label={c.label ?? c.id}
      placeholder={c.placeholder ?? '—'}
      disabled={off(c)}
      value={drafts[c.id!] ?? str(c.value)}
      oninput={(e) => (drafts[c.id!] = e.currentTarget.value)}
      onblur={() => commitText(c, 'text')}
      onkeydown={(e) => keys(e, c)}
      class="h-8 {inputCls}"
    />
  {:else if c.type === 'longText'}
    <textarea
      aria-label={c.label ?? c.id}
      placeholder={c.placeholder ?? '—'}
      disabled={off(c)}
      rows="3"
      value={drafts[c.id!] ?? str(c.value)}
      oninput={(e) => (drafts[c.id!] = e.currentTarget.value)}
      onblur={() => commitText(c, 'text')}
      onkeydown={(e) => keys(e, c, true)}
      class="py-1.5 {inputCls}"></textarea>
  {:else if c.type === 'number'}
    <input
      type="text"
      inputmode="decimal"
      aria-label={c.label ?? c.id}
      placeholder={c.placeholder ?? '—'}
      disabled={off(c)}
      value={drafts[c.id!] ?? (typeof c.value === 'number' ? String(c.value) : '')}
      oninput={(e) => (drafts[c.id!] = e.currentTarget.value)}
      onblur={() => commitText(c, 'number')}
      onkeydown={(e) => keys(e, c)}
      class="h-8 w-28 {inputCls}"
    />
  {:else if c.type === 'toggle'}
    <Checkbox
      checked={c.value === true}
      disabled={off(c)}
      label={layout === 'bar' ? (c.label ?? c.id) : undefined}
      aria-label={c.label ?? c.id}
      onchange={(e) => onchange({ id: c.id!, value: e.currentTarget.checked })}
    />
  {:else if c.type === 'select'}
    <OptionPicker
      label={c.label ?? c.id!}
      options={opts(c)}
      value={typeof c.value === 'string' && c.value ? [c.value] : []}
      clearable={c.clearable ?? true}
      placeholder={c.placeholder ?? '—'}
      disabled={off(c)}
      onchange={(ids) => onchange({ id: c.id!, value: ids[0] ?? null })}
    />
  {:else if c.type === 'multiSelect'}
    <OptionPicker
      label={c.label ?? c.id!}
      options={opts(c)}
      value={list(c.value)}
      multiple
      placeholder={c.placeholder ?? '—'}
      disabled={off(c)}
      onchange={(ids) => onchange({ id: c.id!, value: ids })}
    />
  {:else if c.type === 'people'}
    {@const multiple = c.multiple !== false}
    {#if multiple && c.commitments && layout === 'pane' && list(c.value).length}
      <ul class="flex flex-col gap-1">
        {#each list(c.value) as uid (uid)}
          {@const p = people.find((x) => x.id === uid)}
          <li class="group flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-surface-2">
            <PersonAvatar {uid} size={20} />
            <span class="min-w-0 flex-1 truncate text-sm">{p?.name ?? 'Not on this board'}</span>
            {#if oncommit}
              <DatePicker
                value={commitments[uid] ?? null}
                {tz}
                withTime={false}
                placeholder="Commit…"
                disabled={off(c)}
                class="w-28 [&_button]:h-7 [&_button]:border-transparent [&_button]:px-1.5 [&_button]:text-xs"
                onchange={(v) => oncommit(uid, v)}
              />
            {/if}
            {#if !off(c)}
              <button
                type="button"
                aria-label="Remove {p?.name ?? ''}"
                onclick={() =>
                  onchange({ id: c.id!, value: list(c.value).filter((u) => u !== uid) })}
                class="rounded p-0.5 text-subtle opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"
                ><X size={13} /></button
              >
            {/if}
          </li>
        {/each}
      </ul>
      {#if !off(c)}
        <OptionPicker
          label="Add {c.label ?? ''}"
          options={peopleOf(c)}
          value={list(c.value)}
          multiple
          placeholder="+ Add"
          onchange={(ids) => onchange({ id: c.id!, value: ids })}
          class="text-xs [&_span]:text-subtle"
        />
      {/if}
    {:else}
      <OptionPicker
        label={c.label ?? c.id!}
        options={peopleOf(c)}
        value={list(c.value)}
        {multiple}
        clearable={!multiple}
        placeholder={c.placeholder ?? (multiple ? 'Nobody' : '—')}
        disabled={off(c)}
        onchange={(ids) => onchange({ id: c.id!, value: multiple ? ids : (ids[0] ?? null) })}
      />
    {/if}
  {:else if c.type === 'date'}
    <DatePicker
      value={typeof c.value === 'number' ? c.value : null}
      allDay={c.withTime ? (c.allDay ?? true) : true}
      {tz}
      withTime={!!c.withTime}
      disabled={off(c)}
      placeholder={c.placeholder ?? '—'}
      class="[&_button]:border-transparent"
      onchange={(v, allDay) => onchange({ id: c.id!, value: v, allDay })}
    />
  {:else if c.type === 'dateRange'}
    {@const r = (c.value && typeof c.value === 'object' ? c.value : null) as {
      start: number;
      end: number;
    } | null}
    <div class="flex flex-col gap-1">
      <DatePicker
        value={r?.start ?? null}
        {tz}
        withTime={false}
        placeholder="Start"
        disabled={off(c)}
        class="[&_button]:border-transparent"
        onchange={(v) =>
          onchange({
            id: c.id!,
            value: v == null ? null : { start: v, end: Math.max(v, r?.end ?? v) },
          })}
      />
      <DatePicker
        value={r?.end ?? null}
        {tz}
        withTime={false}
        placeholder="End"
        disabled={off(c)}
        class="[&_button]:border-transparent"
        onchange={(v) =>
          onchange({
            id: c.id!,
            value: v == null ? null : { start: Math.min(v, r?.start ?? v), end: v },
          })}
      />
    </div>
  {/if}
{/snippet}

{#if layout === 'pane'}
  {#each shown as c, i (c.id ?? `note-${i}`)}
    {#if c.type === 'note' && !c.label}
      <div data-script-control={c.id ?? 'note'}>{@render control(c)}</div>
    {:else}
      <div
        data-script-control={c.id}
        class="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-2 @3xl:grid-cols-1 @3xl:gap-y-0.5"
      >
        <span class="pt-2 text-xs font-medium text-muted @3xl:pt-0" title={c.help}
          >{c.label ?? c.id}{c.required ? ' *' : ''}</span
        >
        <div class="min-w-0">{@render control(c)}</div>
      </div>
    {/if}
  {/each}
{:else}
  <div class="flex flex-col gap-3">
    {#each shown as c, i (c.id ?? `note-${i}`)}
      <div data-script-control={c.id ?? 'note'} class="flex flex-col gap-1">
        {#if c.type !== 'toggle' && c.label}
          <span class="text-xs font-medium text-muted" title={c.help}>{c.label}</span>
        {/if}
        {@render control(c)}
        {#if c.help && c.type !== 'note'}<span class="text-xs text-subtle">{c.help}</span>{/if}
      </div>
    {/each}
  </div>
{/if}

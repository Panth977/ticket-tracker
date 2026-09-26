<!--
  Per-type layout of a view draft: group / swimlanes (kanban, table), the fields
  a card shows (kanban), the date fields (calendar, timeline), which ticket
  states are included. Table columns are edited on the table itself (drag the
  header edge, the column menu) but can also be toggled here.
-->
<script lang="ts">
  import type { Board, TicketState, ViewInput } from '@tm/shared';
  import Checkbox from '$lib/ui/Checkbox.svelte';
  import { boardFields } from './fields';
  import { DEFAULT_COLUMNS } from './draft';

  interface Props {
    draft: ViewInput;
    board: Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields'>;
    onchange: (draft: ViewInput) => void;
  }
  let { draft, board, onchange }: Props = $props();

  const all = $derived(boardFields(board));
  const groupable = $derived(all.filter((f) => f.groupable));
  const dateFields = $derived(all.filter((f) => f.dateLike));
  const cardable = $derived(all.filter((f) => f.column && f.key !== 'title' && f.key !== 'key'));
  const columnable = $derived(all.filter((f) => f.column));
  const cols = $derived(draft.columns.length ? draft.columns : DEFAULT_COLUMNS);

  const STATES: { id: TicketState; label: string }[] = [
    { id: 'active', label: 'Active' },
    { id: 'archived', label: 'Archived' },
  ];

  function toggleState(s: TicketState, on: boolean) {
    const next = on
      ? [...new Set([...draft.includeStates, s])]
      : draft.includeStates.filter((x) => x !== s);
    if (next.length) onchange({ ...draft, includeStates: next });
  }
  function toggleCard(key: string, on: boolean) {
    onchange({
      ...draft,
      cardFields: on ? [...draft.cardFields, key] : draft.cardFields.filter((k) => k !== key),
    });
  }
  function toggleColumn(key: string, on: boolean) {
    const existing = cols.find((c) => c.field === key);
    const next = existing
      ? cols.map((c) => (c.field === key ? { ...c, hidden: !on } : c))
      : [...cols, { field: key, width: 140 }];
    onchange({
      ...draft,
      columns: next.map((c) => (c.hidden ? c : { field: c.field, width: c.width })),
    });
  }
</script>

<div class="flex w-80 flex-col gap-3 p-3 text-xs">
  {#if draft.type === 'kanban' || draft.type === 'table'}
    <label class="flex items-center justify-between gap-2">
      <span class="text-muted">{draft.type === 'kanban' ? 'Columns' : 'Group by'}</span>
      <select
        class="h-7 w-44 rounded-md border border-line bg-surface px-1.5"
        value={draft.groupBy ?? ''}
        onchange={(e) =>
          onchange({
            ...draft,
            groupBy: e.currentTarget.value || (draft.type === 'kanban' ? 'stage' : null),
          })}
      >
        {#if draft.type === 'table'}<option value="">No grouping</option>{/if}
        {#each groupable as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
      </select>
    </label>
  {/if}
  {#if draft.type === 'kanban'}
    <label class="flex items-center justify-between gap-2">
      <span class="text-muted">Swimlanes</span>
      <select
        class="h-7 w-44 rounded-md border border-line bg-surface px-1.5"
        value={draft.subGroupBy ?? ''}
        onchange={(e) => onchange({ ...draft, subGroupBy: e.currentTarget.value || null })}
      >
        <option value="">None</option>
        {#each groupable.filter((f) => f.key !== draft.groupBy) as f (f.key)}<option value={f.key}
            >{f.label}</option
          >{/each}
      </select>
    </label>
    <fieldset class="flex flex-col gap-1">
      <legend class="mb-1 text-muted">Card shows</legend>
      {#each cardable as f (f.key)}
        <Checkbox
          label={f.label}
          checked={draft.cardFields.includes(f.key)}
          onchange={(e) => toggleCard(f.key, e.currentTarget.checked)}
        />
      {/each}
    </fieldset>
  {/if}
  {#if draft.type === 'table'}
    <fieldset class="flex max-h-56 flex-col gap-1 overflow-auto">
      <legend class="mb-1 text-muted">Columns</legend>
      {#each columnable as f (f.key)}
        {@const c = cols.find((x) => x.field === f.key)}
        <Checkbox
          label={f.label}
          checked={!!c && !c.hidden}
          disabled={f.key === 'title'}
          onchange={(e) => toggleColumn(f.key, e.currentTarget.checked)}
        />
      {/each}
    </fieldset>
  {/if}
  {#if draft.type === 'calendar' || draft.type === 'timeline'}
    <label class="flex items-center justify-between gap-2">
      <span class="text-muted">{draft.type === 'timeline' ? 'Bar starts' : 'Date'}</span>
      <select
        class="h-7 w-44 rounded-md border border-line bg-surface px-1.5"
        value={draft.dateField ?? 'due'}
        onchange={(e) => onchange({ ...draft, dateField: e.currentTarget.value })}
      >
        {#each dateFields as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
      </select>
    </label>
  {/if}
  {#if draft.type === 'timeline'}
    <label class="flex items-center justify-between gap-2">
      <span class="text-muted">Bar ends</span>
      <select
        class="h-7 w-44 rounded-md border border-line bg-surface px-1.5"
        value={draft.endDateField ?? 'due'}
        onchange={(e) => onchange({ ...draft, endDateField: e.currentTarget.value })}
      >
        {#each dateFields as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
      </select>
    </label>
  {/if}
  <fieldset class="flex flex-col gap-1 border-t border-line pt-2">
    <legend class="mb-1 text-muted">Include tickets that are</legend>
    {#each STATES as s (s.id)}
      <Checkbox
        label={s.label}
        checked={draft.includeStates.includes(s.id)}
        disabled={draft.includeStates.length === 1 && draft.includeStates[0] === s.id}
        onchange={(e) => toggleState(s.id, e.currentTarget.checked)}
      />
    {/each}
  </fieldset>
</div>

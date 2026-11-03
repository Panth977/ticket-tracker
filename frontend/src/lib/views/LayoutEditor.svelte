<!--
  A view's layout: group / swimlanes (Board), grouping (Table) and which ticket
  states are included. What a card and a table row SHOW is the board script's
  (previewTicketCard, previewTicketTable — board-script.html); so is any other
  kind of view (previews).
-->
<script lang="ts">
  import type { Board, TicketState, ViewInput } from '@tm/shared';
  import Checkbox from '$lib/ui/Checkbox.svelte';
  import { boardFields } from './fields';

  interface Props {
    draft: ViewInput;
    board: Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields'>;
    onchange: (draft: ViewInput) => void;
  }
  let { draft, board, onchange }: Props = $props();

  const groupable = $derived(boardFields(board).filter((f) => f.groupable));
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
  const isTable = $derived(draft.type === 'table');
</script>

<div class="flex w-80 flex-col gap-3 p-3 text-xs">
  <label class="flex items-center justify-between gap-2">
    <span class="text-muted">{isTable ? 'Group by' : 'Columns'}</span>
    <select
      class="h-7 w-44 rounded-md border border-line bg-surface px-1.5"
      value={draft.groupBy ?? ''}
      onchange={(e) =>
        onchange({ ...draft, groupBy: e.currentTarget.value || (isTable ? null : 'stage') })}
    >
      {#if isTable}<option value="">No grouping</option>{/if}
      {#each groupable as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
    </select>
  </label>
  {#if !isTable}
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
  {/if}
  <p class="text-subtle">
    Cards, table columns and other views are drawn by the board script (Settings › Script).
  </p>
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

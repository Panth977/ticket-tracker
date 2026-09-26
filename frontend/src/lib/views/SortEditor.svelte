<!-- Multi-key sort for a view draft: field + direction rows; ties fall back to rank (the engine does that). -->
<script lang="ts">
  import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-svelte';
  import type { Board, View } from '@tm/shared';
  import { boardFields } from './fields';

  interface Props {
    sort: View['sort'];
    board: Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields'>;
    onchange: (sort: View['sort']) => void;
  }
  let { sort, board, onchange }: Props = $props();
  const fields = $derived(boardFields(board).filter((f) => f.sortable));
  const unused = $derived(fields.filter((f) => !sort.some((s) => s.field === f.key)));
</script>

<div class="flex w-80 flex-col gap-1.5 p-3">
  {#if sort.length === 0}
    <p class="text-xs text-muted">Manual order (drag to rank). Add a sort to order by a field.</p>
  {/if}
  {#each sort as s, i (s.field)}
    <div class="flex items-center gap-1.5">
      <span class="w-10 text-right text-xs text-muted">{i === 0 ? 'Sort' : 'then'}</span>
      <select
        class="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 text-xs"
        aria-label="Sort field"
        value={s.field}
        onchange={(e) =>
          onchange(sort.map((x, j) => (j === i ? { ...x, field: e.currentTarget.value } : x)))}
      >
        {#each fields as f (f.key)}
          <option value={f.key} disabled={f.key !== s.field && sort.some((x) => x.field === f.key)}
            >{f.label}</option
          >
        {/each}
      </select>
      <button
        type="button"
        class="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-xs hover:bg-surface-2"
        aria-label="Direction"
        onclick={() =>
          onchange(
            sort.map((x, j) => (j === i ? { ...x, dir: x.dir === 'asc' ? 'desc' : 'asc' } : x)),
          )}
      >
        {#if s.dir === 'asc'}<ArrowUp size={12} /> Asc{:else}<ArrowDown size={12} /> Desc{/if}
      </button>
      <button
        type="button"
        class="grid size-7 place-items-center rounded text-subtle hover:text-danger"
        aria-label="Remove sort"
        onclick={() => onchange(sort.filter((_, j) => j !== i))}><Trash2 size={13} /></button
      >
    </div>
  {/each}
  {#if unused.length}
    <button
      type="button"
      class="inline-flex items-center gap-1 self-start rounded px-1.5 py-1 text-xs text-accent hover:bg-accent-soft"
      onclick={() => onchange([...sort, { field: unused[0]!.key, dir: 'asc' }])}
    >
      <Plus size={12} /> Sort
    </button>
  {/if}
</div>

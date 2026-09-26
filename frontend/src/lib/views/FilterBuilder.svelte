<!--
  Filter builder (app.json components › Filter builder):
    Where Assignee is me / and Due before end of week / and Client (field) is Acme
    [+ Condition] [+ Group]
  Edits a view draft's filter tree; tokens (me, today, thisWeek, overdue) are
  stored as tokens so a shared view means the same to everyone who opens it.
-->
<script lang="ts">
  import type { Board, FilterNode } from '@tm/shared';
  import FilterGroupEditor from './FilterGroupEditor.svelte';
  import { asRoot, normalize } from './filter';

  interface Props {
    filter: FilterNode | null;
    board: Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields'>;
    people: { uid: string; name: string; email: string }[];
    onchange: (filter: FilterNode | null) => void;
  }
  let { filter, board, people, onchange }: Props = $props();

  const root = $derived(asRoot(filter));
</script>

<div class="flex w-[min(40rem,90vw)] flex-col gap-2 p-3">
  {#if root.children.length === 0}
    <p class="text-xs text-muted">No filters — every ticket in this view's states is shown.</p>
  {/if}
  <FilterGroupEditor
    {root}
    group={root}
    path={[]}
    {board}
    {people}
    onchange={(r) => onchange(normalize(r))}
  />
</div>

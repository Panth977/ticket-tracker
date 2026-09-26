<!--
  One group of the filter tree: its conditions and (at the top level) nested
  groups. Every edit rebuilds the ROOT through lib/views/filter and hands it to
  `onchange` — the group never mutates what it was given.
-->
<script lang="ts">
  import { Plus, Trash2 } from 'lucide-svelte';
  import {
    isFilterGroup,
    type Board,
    type Cmp,
    type FilterGroup,
    type FilterLeaf,
  } from '@tm/shared';
  import FilterGroupEditor from './FilterGroupEditor.svelte';
  import FilterValue from './FilterValue.svelte';
  import {
    boardFields,
    CMP_LABEL,
    cmpsFor,
    defaultValue,
    fieldInfo,
    NO_VALUE_CMPS,
  } from './fields';
  import { addChild, removeAt, setLeaf, setOp, type NodePath } from './filter';

  interface Props {
    root: FilterGroup;
    group: FilterGroup;
    path: NodePath;
    board: Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields'>;
    people: { uid: string; name: string; email: string }[];
    onchange: (root: FilterGroup) => void;
  }
  let { root, group, path, board, people, onchange }: Props = $props();

  const fields = $derived(boardFields(board).filter((f) => f.filterable));

  function newLeaf(field = 'assignee'): FilterLeaf {
    const info = fieldInfo(board, field)!;
    const cmp = cmpsFor(info.kind)[0]!;
    const value = defaultValue(info.kind, cmp);
    return value === undefined ? { field, cmp } : { field, cmp, value };
  }

  function changeField(p: NodePath, field: string) {
    onchange(setLeaf(root, p, { ...newLeaf(field) }));
  }
  function changeCmp(p: NodePath, leaf: FilterLeaf, cmp: Cmp) {
    const info = fieldInfo(board, leaf.field);
    if (!info) return;
    // Keep a compatible operand (in ↔ notIn keep their list); otherwise start fresh.
    const keep =
      !NO_VALUE_CMPS.includes(cmp) &&
      !NO_VALUE_CMPS.includes(leaf.cmp) &&
      (cmp === 'between') === (leaf.cmp === 'between');
    const value = keep ? leaf.value : defaultValue(info.kind, cmp);
    const next: FilterLeaf = { field: leaf.field, cmp };
    if (value !== undefined) next.value = value;
    onchange(setLeaf(root, p, { ...next, value }));
  }
  const cmpLabel = (kind: string, c: Cmp) =>
    kind === 'checkbox' ? (c === 'notEmpty' ? 'is checked' : 'is not checked') : CMP_LABEL[c];
</script>

<div
  class="flex flex-col gap-1.5 {path.length ? 'rounded-md border border-line bg-bg/50 p-2' : ''}"
>
  {#each group.children as node, i (i)}
    {@const p = [...path, i]}
    <div class="flex flex-wrap items-start gap-1.5">
      <span class="w-14 shrink-0 pt-1.5 text-right text-xs text-muted">
        {#if i === 0}
          Where
        {:else if i === 1}
          <select
            class="h-6 rounded border border-line bg-surface px-1 text-xs"
            aria-label="Combine conditions with"
            value={group.op}
            onchange={(e) => onchange(setOp(root, path, e.currentTarget.value as 'and' | 'or'))}
          >
            <option value="and">and</option>
            <option value="or">or</option>
          </select>
        {:else}
          {group.op}
        {/if}
      </span>
      {#if isFilterGroup(node)}
        <div class="min-w-0 flex-1">
          <FilterGroupEditor {root} group={node} path={p} {board} {people} {onchange} />
        </div>
      {:else}
        {@const info = fieldInfo(board, node.field)}
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <select
            class="h-7 rounded-md border border-line bg-surface px-1.5 text-xs"
            aria-label="Field"
            value={node.field}
            onchange={(e) => changeField(p, e.currentTarget.value)}
          >
            {#if !info}<option value={node.field}>(removed field)</option>{/if}
            {#each fields as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
          </select>
          {#if info}
            <select
              class="h-7 rounded-md border border-line bg-surface px-1.5 text-xs"
              aria-label="Condition"
              value={node.cmp}
              onchange={(e) => changeCmp(p, node, e.currentTarget.value as Cmp)}
            >
              {#each cmpsFor(info.kind) as c (c)}<option value={c}>{cmpLabel(info.kind, c)}</option
                >{/each}
            </select>
            <FilterValue
              {info}
              cmp={node.cmp}
              value={node.value}
              {people}
              onchange={(value) => onchange(setLeaf(root, p, { value }))}
            />
          {/if}
        </div>
      {/if}
      <button
        type="button"
        class="grid size-7 shrink-0 place-items-center rounded text-subtle hover:bg-surface-2 hover:text-danger"
        aria-label="Remove condition"
        onclick={() => onchange(removeAt(root, p))}
      >
        <Trash2 size={13} />
      </button>
    </div>
  {/each}
  <div class="flex gap-2 {group.children.length ? 'pl-16' : ''}">
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-accent hover:bg-accent-soft"
      onclick={() => onchange(addChild(root, path, newLeaf()))}
    >
      <Plus size={12} /> Condition
    </button>
    {#if path.length === 0}
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted hover:bg-surface-2"
        onclick={() =>
          onchange(
            addChild(root, path, { op: group.op === 'and' ? 'or' : 'and', children: [newLeaf()] }),
          )}
      >
        <Plus size={12} /> Group
      </button>
    {/if}
  </div>
</div>

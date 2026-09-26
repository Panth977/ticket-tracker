<!--
  The table's bulk bar: 14 selected · Stage · Priority · +Tag · +Assignee · Due · Archive.
  One ticketBulk call per action; the server resolves my role once and SKIPS
  (does not fail) tickets a commenter's grant does not cover.
-->
<script lang="ts">
  import { Archive, X } from 'lucide-svelte';
  import Button from '$lib/ui/Button.svelte';
  import DatePicker from '$lib/ui/DatePicker.svelte';
  import ChoicePicker, { type ChoiceItem } from '$lib/views/pickers/ChoicePicker.svelte';
  import { useBoard, type BoardDoc } from './context.svelte';
  import { bulk } from './ops';

  interface Props {
    /** The loaded board (§Q4) — never null. */
    board: BoardDoc;
    ids: string[];
    onclear: () => void;
  }
  let { board, ids, onclear }: Props = $props();
  const bs = useBoard();
  const opts = (
    xs: { id: string; name: string; color?: string; position: number }[],
  ): ChoiceItem[] =>
    [...xs]
      .sort((a, b) => a.position - b.position)
      .map((o) => ({ id: o.id, label: o.name, color: o.color }));
  const editor = $derived(bs.canEdit);
</script>

<div
  role="toolbar"
  aria-label="Bulk actions"
  class="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-4 py-2 text-sm shadow-pop"
>
  <span class="font-medium">{ids.length} selected</span>
  <span class="h-4 w-px bg-line"></span>
  <ChoicePicker
    items={opts(board.stages)}
    selected={[]}
    placeholder="Stage"
    label="Move to stage"
    onchange={(v) => v[0] && bulk(bs, ids, { type: 'stage', stageId: v[0] })}
  />
  {#if editor}
    <ChoicePicker
      items={opts(board.priorities)}
      selected={[]}
      placeholder="Priority"
      label="Set priority"
      allowNone
      onchange={(v) => bulk(bs, ids, { type: 'priority', priorityId: v[0] ?? null })}
    />
    <ChoicePicker
      items={opts(board.tags)}
      selected={[]}
      placeholder="+Tag"
      label="Add tag"
      onchange={(v) => v[0] && bulk(bs, ids, { type: 'addTag', tagId: v[0] })}
    />
    <ChoicePicker
      items={bs.peopleChoices}
      selected={[]}
      placeholder="+Assignee"
      label="Add assignee"
      onchange={(v) => v[0] && bulk(bs, ids, { type: 'addAssignee', uid: v[0] })}
    />
    <DatePicker
      value={null}
      withTime={false}
      tz={bs.tz}
      placeholder="Due"
      label="Set due date"
      onchange={(v) => bulk(bs, ids, { type: 'due', dueAt: v })}
    />
    <Button
      size="sm"
      variant="ghost"
      icon={Archive}
      onclick={() => bulk(bs, ids, { type: 'state', state: 'archived' }).then(onclear)}
      >Archive</Button
    >
  {/if}
  <button
    type="button"
    class="ml-auto grid size-7 place-items-center rounded text-muted hover:bg-surface-2"
    aria-label="Clear selection"
    onclick={onclear}
  >
    <X size={15} />
  </button>
</div>

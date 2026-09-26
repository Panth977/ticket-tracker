<!--
  One table cell: shows a field's value and, when `editing`, the inline editor
  for its FieldType. Every save is one ticketUpdate (optimistic) through ops.
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- a URL field value, external by definition */
  import type { FieldValue, TicketPatch } from '@tm/shared';
  import Badge from '$lib/ui/Badge.svelte';
  import DatePicker from '$lib/ui/DatePicker.svelte';
  import PersonChip from '$lib/ui/PersonChip.svelte';
  import ChoicePicker, { type ChoiceItem } from '$lib/views/pickers/ChoicePicker.svelte';
  import { dueTone, fieldText, formatDate, formatNumber } from '$lib/views/format';
  import Avatars from './Avatars.svelte';
  import FieldInput from './FieldInput.svelte';
  import TicketCard from './TicketCard.svelte';
  import { useBoard, type BoardDoc, type BoardTicket } from './context.svelte';
  import { updateTicket } from './ops';

  interface Props {
    /** The loaded board (§Q4) — never null. */
    board: BoardDoc;
    ticket: BoardTicket;
    field: string;
    editing: boolean;
    onclose: () => void;
  }
  let { board, ticket: t, field, editing, onclose }: Props = $props();

  /** What the title cell adds: the signals and facts no column carries (§P2). */
  const ROW_FACTS = ['tasks', 'files', 'blocked'];
  const bs = useBoard();

  const opts = (
    xs: { id: string; name: string; color?: string; position: number }[],
  ): ChoiceItem[] =>
    [...xs]
      .sort((a, b) => a.position - b.position)
      .map((o) => ({ id: o.id, label: o.name, color: o.color }));
  const people = $derived<ChoiceItem[]>(bs.peopleChoices);
  const def = $derived(
    field.startsWith('fields.') ? board.fields.find((f) => `fields.${f.id}` === field) : undefined,
  );
  const priority = $derived(board.priorities.find((p) => p.id === t.priorityId));
  const stage = $derived(bs.stage(t.stageId));

  function save(patch: TicketPatch) {
    void updateTicket(bs, t, patch);
  }
  let title = $state('');
  $effect(() => {
    if (editing && field === 'title') title = t.title;
  });
  function saveTitle() {
    const v = title.trim();
    if (v && v !== t.title) save({ title: v });
    onclose();
  }
  /** Commenters may change the stage within their grant; everything else needs edit. */
  const stageItems = $derived(
    opts(board.stages).filter((s) => s.id === t.stageId || bs.canMoveTo(t, s.id)),
  );
</script>

{#if editing && field === 'title'}
  <!-- svelte-ignore a11y_autofocus -->
  <input
    class="h-7 w-full rounded border border-accent bg-surface px-1.5 text-sm outline-none"
    bind:value={title}
    autofocus
    aria-label="Title"
    onblur={saveTitle}
    onkeydown={(e) => {
      if (e.key === 'Enter') saveTitle();
      if (e.key === 'Escape') onclose();
    }}
  />
{:else if editing && field === 'stage'}
  <ChoicePicker
    items={stageItems}
    selected={[t.stageId]}
    label="Stage"
    autoOpen
    {onclose}
    onchange={(ids) => ids[0] && ids[0] !== t.stageId && save({ stageId: ids[0] })}
  />
{:else if editing && field === 'priority'}
  <ChoicePicker
    items={opts(board.priorities)}
    selected={t.priorityId ? [t.priorityId] : []}
    allowNone
    label="Priority"
    autoOpen
    {onclose}
    onchange={(ids) => save({ priorityId: ids[0] ?? null })}
  />
{:else if editing && field === 'assignee'}
  <ChoicePicker
    items={people}
    selected={t.assigneeUids}
    multi
    label="Assignees"
    autoOpen
    {onclose}
    onchange={(ids) => save({ assigneeUids: ids })}
  />
{:else if editing && field === 'tag'}
  <ChoicePicker
    items={opts(board.tags)}
    selected={t.tagIds}
    multi
    label="Tags"
    autoOpen
    {onclose}
    onchange={(ids) => save({ tagIds: ids })}
  />
{:else if editing && (field === 'due' || field === 'start')}
  <DatePicker
    value={field === 'due' ? t.dueAt : t.startAt}
    allDay={field === 'due' ? t.dueAllDay : true}
    tz={bs.tz}
    withTime={field === 'due'}
    label={field === 'due' ? 'Due' : 'Start'}
    onchange={(v, allDay) => {
      save(field === 'due' ? { dueAt: v, dueAllDay: allDay } : { startAt: v });
      onclose();
    }}
  />
{:else if editing && field === 'estimate'}
  <!-- svelte-ignore a11y_autofocus -->
  <input
    type="number"
    min="0"
    step="any"
    autofocus
    aria-label="Estimate"
    class="h-7 w-full rounded border border-accent bg-surface px-1.5 text-sm outline-none"
    value={t.estimate ?? ''}
    onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    onblur={(e) => {
      const v = e.currentTarget.value;
      const n = v === '' ? null : Math.max(0, Number(v));
      if (n !== t.estimate) save({ estimate: n });
      onclose();
    }}
  />
{:else if editing && def}
  <FieldInput
    {def}
    value={t.fields[def.id]}
    autofocus
    {onclose}
    onchange={(v: FieldValue) => {
      save({ fields: { [def.id]: v } });
      if (def.type !== 'multiSelect' && def.type !== 'people' && def.type !== 'ticketRelation')
        onclose();
    }}
  />
{:else}
  <!-- display -->
  {#if field === 'key'}
    <span class="font-mono text-xs text-subtle">{t.key}</span>
  {:else if field === 'title'}
    <!--
      §P2 › reuse: the title cell IS the card, in one line — the same component
      the kanban and My work draw, so all three agree on what a ticket is
      saying. It asks only for the facts that have no column of their own; the
      rest are already cells beside it.
    -->
    <TicketCard {board} ticket={t} cardFields={ROW_FACTS} layout="row" showKey={false} />
  {:else if field === 'stage'}
    {#if stage}<Badge color={stage.color}>{stage.name}</Badge>{/if}
  {:else if field === 'priority'}
    {#if priority}<Badge color={priority.color}>{priority.name}</Badge>{/if}
  {:else if field === 'assignee'}
    {#if t.assigneeUids.length === 1}<PersonChip
        uid={t.assigneeUids[0]}
        layout="compact"
        size={18}
      />
    {:else if t.assigneeUids.length}<Avatars uids={t.assigneeUids} size={18} max={4} />{/if}
  {:else if field === 'tag'}
    <span class="flex gap-1 overflow-hidden">
      {#each t.tagIds as id (id)}
        {@const tag = board.tags.find((x) => x.id === id)}
        {#if tag}<Badge color={tag.color}>{tag.name}</Badge>{/if}
      {/each}
    </span>
  {:else if field === 'due'}
    {#if t.dueAt != null}
      {@const tone = dueTone(t, bs.tz, bs.now)}
      <span class={tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : ''}>
        {formatDate(t.dueAt, bs.tz, { allDay: t.dueAllDay, now: bs.now })}
      </span>
    {/if}
  {:else if field === 'start'}
    {formatDate(t.startAt, bs.tz, { now: bs.now })}
  {:else if field === 'createdAt'}
    <span class="text-muted">{formatDate(t.createdAt, bs.tz, { now: bs.now })}</span>
  {:else if field === 'updatedAt'}
    <span class="text-muted">{formatDate(t.updatedAt, bs.tz, { now: bs.now })}</span>
  {:else if field === 'createdBy'}
    <PersonChip uid={t.createdBy} layout="compact" size={18} />
  {:else if field === 'estimate'}
    {t.estimate != null ? formatNumber(t.estimate) : ''}
  {:else if def}
    {@const v = t.fields[def.id]}
    {#if def.type === 'person' && typeof v === 'string'}
      <PersonChip uid={v} layout="compact" size={18} />
    {:else if def.type === 'people' && Array.isArray(v)}
      <Avatars uids={v as string[]} size={18} max={4} />
    {:else if def.type === 'ticketRelation' && Array.isArray(v)}
      <span class="truncate font-mono text-xs text-muted"
        >{(v as string[]).map((id) => bs.byId.get(id)?.key ?? '…').join(', ')}</span
      >
    {:else if def.type === 'url' && typeof v === 'string'}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an external link typed by a person -->
      <a
        href={v}
        target="_blank"
        rel="noopener noreferrer"
        class="truncate text-accent hover:underline"
        onclick={(e) => e.stopPropagation()}>{v}</a
      >
    {:else}
      <span class="truncate">{fieldText(board, def.id, v, bs.tz)}</span>
    {/if}
  {/if}
{/if}

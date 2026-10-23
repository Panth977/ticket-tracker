<!--
  A person's StageGrant.
  · Commenter: the stages they may move tickets BETWEEN, optionally only
    tickets assigned to them, and optionally only along PATHS (X → Y, Z).
    No stages = no grant (read + comment only).
  · Editor (`editor`): paths only — they edit everything else freely; with
    paths set, a ticket's stage changes only along them. No paths = no limit.
  <StageGrantEditor {stages} grant={m.stageGrant} onchange={(g) => …} />
-->
<script lang="ts">
  import type { Stage, StageGrant } from '@tm/shared';
  import ChoicePicker from '$lib/views/pickers/ChoicePicker.svelte';
  import { stageChoices } from './stageMark';

  interface Props {
    stages: Stage[];
    grant: StageGrant | null | undefined;
    disabled?: boolean;
    /** The person is an editor: only the paths apply. */
    editor?: boolean;
    /** null = remove the grant. */
    onchange: (grant: StageGrant | null) => void;
    label?: string;
  }
  let {
    stages,
    grant,
    disabled = false,
    editor = false,
    onchange,
    label = 'Stages they may move tickets between',
  }: Props = $props();

  const items = $derived(stageChoices(stages));
  const selected = $derived(editor ? stages.map((s) => s.id) : (grant?.stages ?? []));
  const moves = $derived(grant?.moves);
  const byId = $derived(new Map(stages.map((s) => [s.id, s])));

  function emit(next: { stages: string[]; assignedOnly?: boolean; moves?: StageGrant['moves'] }) {
    if (editor) {
      onchange(next.moves ? { stages: stages.map((s) => s.id), moves: next.moves } : null);
      return;
    }
    if (!next.stages.length) return onchange(null);
    const m = next.moves
      ? Object.fromEntries(
          Object.entries(next.moves)
            .filter(([from]) => next.stages.includes(from))
            .map(([from, to]) => [from, to.filter((t) => next.stages.includes(t) && t !== from)]),
        )
      : undefined;
    onchange({
      stages: next.stages,
      ...(next.assignedOnly ? { assignedOnly: true } : {}),
      ...(m ? { moves: m } : {}),
    });
  }
  const cur = () => ({ stages: selected, assignedOnly: grant?.assignedOnly ?? false, moves });

  /** Turning paths on starts from today's freedom: every stage to every other. */
  function allPaths(ids: string[]): Record<string, string[]> {
    return Object.fromEntries(ids.map((f) => [f, ids.filter((t) => t !== f)]));
  }
</script>

<div class="flex flex-col gap-2 text-xs" data-testid="stage-grant">
  <div class="flex flex-wrap items-center gap-2">
    {#if !editor}
      <ChoicePicker
        {items}
        {selected}
        multi
        placeholder="No stages"
        {label}
        {disabled}
        onchange={(ids) => emit({ ...cur(), stages: ids })}
      />
      {#if selected.length}
        <label class="flex items-center gap-1 text-muted">
          <input
            type="checkbox"
            class="size-3.5 accent-[var(--tm-accent)]"
            checked={grant?.assignedOnly ?? false}
            {disabled}
            onchange={(e) => emit({ ...cur(), assignedOnly: e.currentTarget.checked })}
          />
          only their tickets
        </label>
      {/if}
    {/if}
    {#if selected.length > 1}
      <label class="flex items-center gap-1 text-muted">
        <input
          type="checkbox"
          class="size-3.5 accent-[var(--tm-accent)]"
          data-testid="stage-paths-toggle"
          checked={!!moves}
          {disabled}
          onchange={(e) =>
            emit({ ...cur(), moves: e.currentTarget.checked ? allPaths(selected) : undefined })}
        />
        {editor ? 'limit stage moves to these paths' : 'only along these paths'}
      </label>
    {/if}
  </div>
  {#if moves && selected.length > 1}
    <ul class="flex flex-col gap-1 border-l-2 border-line pl-3" data-testid="stage-paths">
      {#each selected as from (from)}
        <li class="flex flex-wrap items-center gap-2">
          <span class="min-w-24 font-medium">{byId.get(from)?.name ?? from} →</span>
          <ChoicePicker
            items={items.filter((i) => i.id !== from && selected.includes(i.id))}
            selected={moves[from] ?? []}
            multi
            placeholder="nowhere"
            label="Stages a ticket in {byId.get(from)?.name ?? from} may move to"
            {disabled}
            onchange={(ids) => emit({ ...cur(), moves: { ...moves, [from]: ids } })}
          />
        </li>
      {/each}
    </ul>
  {/if}
</div>

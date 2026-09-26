<!--
  Board settings › Stages: the board's columns in its own words. Each stage
  has a CATEGORY (what the system reads: done / cancelled end the clock,
  backlog / todo / active are open), an optional WIP limit and the custom
  fields it `requires` before a ticket may enter it (enforced by the server —
  a drag that misses one opens the requires prompt).
  Removing a stage that still holds tickets asks where they go (remap).
-->
<script lang="ts">
  import { STAGE_CATEGORIES, type Stage, type StageCategory } from '@tm/shared';
  import ChoicePicker from '$lib/views/pickers/ChoicePicker.svelte';
  import OptionListEditor from './OptionListEditor.svelte';
  import RemapDialog from './RemapDialog.svelte';
  import Section from './Section.svelte';
  import { byPosition, useDraft, useRestore, useSettings } from './draft.svelte';
  import { saveBoard, type Remap } from './save';
  import { routes } from '$lib/layout/routes';

  const s = useSettings();
  const draft = useDraft<Stage[]>(() => byPosition(s.board.stages));
  let remapper: RemapDialog | null = $state(null);

  const CATEGORY_LABEL: Record<StageCategory, string> = {
    backlog: 'Backlog',
    todo: 'To do',
    active: 'In progress',
    done: 'Done',
    cancelled: 'Cancelled',
  };
  const fieldItems = $derived(
    s.board.fields.filter((f) => !f.archived).map((f) => ({ id: f.id, label: f.name })),
  );
  const noDone = $derived(!draft.value.some((st) => st.category === 'done'));

  useRestore(() => 'stages', draft);

  /** Saves in the background; a stage with tickets asks where they go, then saves again. */
  function save(remap: Remap = {}) {
    const value = $state.snapshot(draft.value) as typeof draft.value;
    const stagesBefore = s.board.stages;
    saveBoard(
      s.board.id,
      { stages: value },
      Object.keys(remap).length ? remap : undefined,
      'stages',
      {
        section: 'stages',
        openTo: routes.boardSettings(s.board.key, 'stages'),
        value,
        onNeeds: async (needs) => {
          draft.value = value;
          if (needs.kind !== 'stage') return;
          const gone = stagesBefore.find((x) => x.id === needs.id);
          const to = await remapper?.ask({
            kind: 'stage',
            name: gone?.name ?? 'a removed stage',
            count: needs.count,
            choices: value.map((x) => ({ id: x.id, name: x.name })),
          });
          if (to) save({ ...remap, stages: { ...remap.stages, [needs.id]: to } });
        },
      },
    );
    draft.commit();
  }
</script>

<Section
  title="Stages"
  description="The columns of your board, in order. The category tells TaskManager what a stage means — done and cancelled stop due-date reminders and count as finished."
  dirty={draft.dirty}
  readOnly={s.readOnly}
  onsave={save}
  onreset={draft.reset}
>
  <div class="max-w-2xl">
    <OptionListEditor
      label="Stages"
      items={draft.value}
      onchange={(xs) => (draft.value = xs)}
      make={(b) => ({ ...b, category: 'todo' as StageCategory })}
      min={1}
      addLabel="Add stage"
      readOnly={s.readOnly}
    >
      {#snippet row(st, patch)}
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <label class="flex items-center gap-1.5">
            <span class="text-muted">Category</span>
            <select
              class="h-7 rounded border border-line bg-surface px-1"
              value={st.category}
              disabled={s.readOnly}
              onchange={(e) => patch({ category: e.currentTarget.value as StageCategory })}
            >
              {#each STAGE_CATEGORIES as c (c)}<option value={c}>{CATEGORY_LABEL[c]}</option>{/each}
            </select>
          </label>
          <label class="flex items-center gap-1.5">
            <span class="text-muted">WIP limit</span>
            <input
              type="number"
              min="1"
              step="1"
              placeholder="None"
              class="h-7 w-20 rounded border border-line bg-surface px-1.5"
              disabled={s.readOnly}
              value={st.wipLimit ?? ''}
              onchange={(e) => {
                const n = Math.floor(Number(e.currentTarget.value));
                patch({ wipLimit: e.currentTarget.value !== '' && n > 0 ? n : undefined });
              }}
            />
          </label>
          <span class="flex items-center gap-1.5">
            <span class="text-muted">Requires</span>
            {#if fieldItems.length}
              <ChoicePicker
                items={fieldItems}
                selected={st.requires ?? []}
                multi
                placeholder="No fields"
                label="Fields required to enter {st.name}"
                disabled={s.readOnly}
                onchange={(ids) => patch({ requires: ids.length ? ids : undefined })}
              />
            {:else}
              <span class="text-subtle">add custom fields first</span>
            {/if}
          </span>
        </div>
      {/snippet}
    </OptionListEditor>
    {#if noDone}
      <p class="mt-3 text-sm text-warning">
        No stage has the Done category — tickets on this board can never be finished.
      </p>
    {/if}
  </div>
</Section>

<RemapDialog bind:this={remapper} />

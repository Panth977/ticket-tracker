<!--
  Board settings › Custom fields. The board's own fields (Client, Estimate,
  Device ID…), each stored on tickets under its id, never its name.
  Removing is ARCHIVING: the field is hidden everywhere but every value is
  kept, and it can be brought back. The list saves as one boardUpdate.
-->
<script lang="ts">
  import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Pencil, Plus } from 'lucide-svelte';
  import type { FieldDef } from '@tm/shared';
  import Badge from '$lib/ui/Badge.svelte';
  import Button from '$lib/ui/Button.svelte';
  import FieldEditor, { FIELD_TYPE_LABEL } from './FieldEditor.svelte';
  import Section from './Section.svelte';
  import { byPosition, fieldId, renumber, useDraft, useRestore, useSettings } from './draft.svelte';
  import { saveBoard } from './save';
  import { routes } from '$lib/layout/routes';

  const s = useSettings();
  const draft = useDraft<FieldDef[]>(() => byPosition(s.board.fields));
  let editorOpen = $state(false);
  let editing = $state<FieldDef | null>(null);
  let isNew = $state(false);
  let showArchived = $state(false);

  const live = $derived(draft.value.filter((f) => !f.archived));
  const archived = $derived(draft.value.filter((f) => f.archived));
  const usedBy = (id: string) =>
    s.board.stages.filter((st) => st.requires?.includes(id)).map((st) => st.name);

  function add() {
    editing = {
      id: fieldId(draft.value.map((f) => f.id)),
      name: '',
      type: 'text',
      position: draft.value.length,
    };
    isNew = true;
    editorOpen = true;
  }
  function edit(f: FieldDef) {
    editing = f;
    isNew = false;
    editorOpen = true;
  }
  function put(def: FieldDef) {
    const exists = draft.value.some((f) => f.id === def.id);
    draft.value = renumber(
      exists ? draft.value.map((f) => (f.id === def.id ? def : f)) : [...draft.value, def],
    );
  }
  function setArchived(f: FieldDef, on: boolean) {
    put({ ...f, archived: on || undefined });
  }
  function move(f: FieldDef, d: -1 | 1) {
    const xs = [...live];
    const i = xs.findIndex((x) => x.id === f.id);
    const j = i + d;
    if (j < 0 || j >= xs.length) return;
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    draft.value = renumber([...xs, ...archived]);
  }
  function save() {
    const value = $state.snapshot(draft.value) as typeof draft.value;
    saveBoard(s.board.id, { fields: value }, undefined, 'custom fields', {
      section: 'fields',
      openTo: routes.boardSettings(s.board.key, 'fields'),
      value,
    });
    draft.commit();
  }
  useRestore(() => 'fields', draft);
  const taken = $derived(
    draft.value.filter((f) => f.id !== editing?.id).map((f) => f.name.toLowerCase()),
  );
</script>

<Section
  title="Custom fields"
  description="Fields of your own on every ticket. Removing one archives it — the values are kept and it can come back."
  dirty={draft.dirty}
  readOnly={s.readOnly}
  onsave={save}
  onreset={draft.reset}
>
  {#snippet actions()}
    {#if !s.readOnly}<Button icon={Plus} onclick={add}>New field</Button>{/if}
  {/snippet}
  <div class="max-w-2xl">
    {#if live.length === 0}
      <p class="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
        No custom fields yet. Add one for anything your team tracks: a client, a device ID, story
        points.
      </p>
    {:else}
      <ul class="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
        {#each live as f, i (f.id)}
          {@const stages = usedBy(f.id)}
          <li class="flex flex-wrap items-center gap-2 px-3 py-2">
            <span class="min-w-0 flex-1">
              <span class="font-medium">{f.name}</span>
              <span class="ml-2 text-xs text-muted"
                >{FIELD_TYPE_LABEL[f.type]}{#if f.options?.length}
                  · {f.options.length} options{/if}</span
              >
            </span>
            {#if f.required}<Badge tone="warning">Required</Badge>{/if}
            {#if f.showOnCard}<Badge>On card</Badge>{/if}
            {#if stages.length}<span title="Required to enter: {stages.join(', ')}"
                ><Badge>Stage rule</Badge></span
              >{/if}
            {#if !s.readOnly}
              <button
                type="button"
                class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2 disabled:opacity-30"
                aria-label="Move {f.name} up"
                disabled={i === 0}
                onclick={() => move(f, -1)}><ArrowUp size={13} /></button
              >
              <button
                type="button"
                class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2 disabled:opacity-30"
                aria-label="Move {f.name} down"
                disabled={i === live.length - 1}
                onclick={() => move(f, 1)}><ArrowDown size={13} /></button
              >
              <button
                type="button"
                class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2"
                aria-label="Edit {f.name}"
                onclick={() => edit(f)}><Pencil size={13} /></button
              >
              <button
                type="button"
                class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-30"
                aria-label="Archive {f.name}"
                title={stages.length
                  ? `Required by ${stages.join(', ')} — remove it there first`
                  : 'Archive'}
                disabled={stages.length > 0}
                onclick={() => setArchived(f, true)}><Archive size={13} /></button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if archived.length}
      <button
        type="button"
        class="mt-4 text-sm text-muted hover:text-text"
        onclick={() => (showArchived = !showArchived)}
        aria-expanded={showArchived}
      >
        {showArchived ? 'Hide' : 'Show'}
        {archived.length} archived field{archived.length === 1 ? '' : 's'}
      </button>
      {#if showArchived}
        <ul class="mt-2 flex flex-col divide-y divide-line rounded-lg border border-line">
          {#each archived as f (f.id)}
            <li class="flex items-center gap-2 px-3 py-2 text-muted">
              <span class="flex-1"
                >{f.name} <span class="text-xs">· {FIELD_TYPE_LABEL[f.type]}</span></span
              >
              {#if !s.readOnly}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={ArchiveRestore}
                  onclick={() => setArchived(f, false)}>Restore</Button
                >
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</Section>

<FieldEditor bind:open={editorOpen} field={editing} {isNew} {taken} onsubmit={put} />

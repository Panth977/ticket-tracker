<!--
  Board settings › Aggregates (docs/plan/aggregates.html). The numbers this
  board adds up — Cost (the agents' turn receipts land on it), Time, Points…
  Each has a label, a unit and a period (daily / weekly / monthly). People add
  to a field from a ticket's composer; Analytics charts it.

  Removing is ARCHIVING: no new entries, every total and bucket is kept, and
  it can come back. The period locks once a field has entries. Admins edit;
  everyone else reads. The list saves as one boardUpdate.
-->
<script lang="ts">
  import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Lock, Pencil, Plus } from 'lucide-svelte';
  import { AGG_FIELDS_MAX, formatAgg, type AggFieldDef } from '@tm/shared';
  import Badge from '$lib/ui/Badge.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import { routes } from '$lib/layout/routes';
  import { aggCountersOf, aggFieldId, allAggFields, entriesWord } from '$lib/aggregates/fields';
  import { PERIOD_LABEL } from '$lib/aggregates/periods';
  import AggFieldEditor from './AggFieldEditor.svelte';
  import Section from './Section.svelte';
  import { renumber, useDraft, useRestore, useSettings } from './draft.svelte';
  import { saveBoard } from './save';

  const s = useSettings();
  const draft = useDraft<AggFieldDef[]>(() => allAggFields(s.board));
  const counters = $derived(aggCountersOf(s.board));
  const locked = (id: string) => (counters[id]?.count ?? 0) > 0;

  let editorOpen = $state(false);
  let editing = $state<AggFieldDef | null>(null);
  let isNew = $state(false);
  let showArchived = $state(false);
  let removing = $state<AggFieldDef | null>(null);
  let removeOpen = $state(false);

  const live = $derived(draft.value.filter((f) => !f.archived));
  const archived = $derived(draft.value.filter((f) => f.archived));
  const full = $derived(draft.value.length >= AGG_FIELDS_MAX);

  function add() {
    editing = {
      id: aggFieldId(draft.value.map((f) => f.id)),
      label: '',
      unit: '',
      period: 'daily',
      position: draft.value.length,
    };
    isNew = true;
    editorOpen = true;
  }
  function edit(f: AggFieldDef) {
    editing = f;
    isNew = false;
    editorOpen = true;
  }
  function put(def: AggFieldDef) {
    const exists = draft.value.some((f) => f.id === def.id);
    draft.value = renumber(
      exists ? draft.value.map((f) => (f.id === def.id ? def : f)) : [...draft.value, def],
    );
  }
  function setArchived(f: AggFieldDef, on: boolean) {
    const next: AggFieldDef = { ...f };
    if (on) next.archived = true;
    else delete next.archived;
    put(next);
  }
  function askRemove(f: AggFieldDef) {
    removing = f;
    removeOpen = true;
  }
  function move(f: AggFieldDef, d: -1 | 1) {
    const xs = [...live];
    const i = xs.findIndex((x) => x.id === f.id);
    const j = i + d;
    if (j < 0 || j >= xs.length) return;
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    draft.value = renumber([...xs, ...archived]);
  }
  function save() {
    const value = $state.snapshot(draft.value) as typeof draft.value;
    saveBoard(s.board.id, { aggFields: value }, undefined, 'aggregate fields', {
      section: 'aggregates',
      openTo: routes.boardSettings(s.board.key, 'aggregates'),
      value,
    });
    draft.commit();
  }
  useRestore(() => 'aggregates', draft);
  const taken = $derived(
    draft.value.filter((f) => f.id !== editing?.id).map((f) => f.label.toLowerCase()),
  );
  const total = (f: AggFieldDef) => {
    const c = counters[f.id];
    return c && c.count > 0 ? `${formatAgg(c.total, f.unit)} · ${entriesWord(c.count)}` : null;
  };
</script>

<Section
  title="Aggregates"
  description="Numbers this board adds up per ticket and per period — Cost, Time, Points. Anyone who can comment adds to them from a ticket's composer; Analytics charts them."
  dirty={draft.dirty}
  readOnly={s.readOnly}
  onsave={save}
  onreset={draft.reset}
>
  {#snippet actions()}
    {#if !s.readOnly}<Button icon={Plus} onclick={add} disabled={full}>New field</Button>{/if}
  {/snippet}
  <div class="max-w-2xl" data-agg-fields>
    {#if live.length === 0}
      <p class="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
        No aggregate fields. Add one for anything your team adds up: hours spent, money, story
        points.
      </p>
    {:else}
      <ul class="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
        {#each live as f, i (f.id)}
          {@const t = total(f)}
          <li class="flex flex-wrap items-center gap-2 px-3 py-2" data-agg-field={f.label}>
            <span class="min-w-0 flex-1">
              <span class="font-medium">{f.label}</span>
              <span class="ml-2 text-xs text-muted"
                >{f.unit ? `in ${f.unit} · ` : ''}{PERIOD_LABEL[f.period]}</span
              >
              {#if t}<span class="block text-xs text-subtle tabular-nums">{t}</span>{/if}
            </span>
            {#if locked(f.id)}<span
                title="The period is fixed: this field has entries"
                class="text-subtle"><Lock size={12} aria-label="Period locked" /></span
              >{/if}
            {#if f.showOnCard}<Badge>On card</Badge>{/if}
            {#if f.id === 'cost'}<span title="Turn receipts add their cost here"
                ><Badge>Receipts</Badge></span
              >{/if}
            {#if !s.readOnly}
              <button
                type="button"
                class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2 disabled:opacity-30"
                aria-label="Move {f.label} up"
                disabled={i === 0}
                onclick={() => move(f, -1)}><ArrowUp size={13} /></button
              >
              <button
                type="button"
                class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2 disabled:opacity-30"
                aria-label="Move {f.label} down"
                disabled={i === live.length - 1}
                onclick={() => move(f, 1)}><ArrowDown size={13} /></button
              >
              <button
                type="button"
                class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2"
                aria-label="Edit {f.label}"
                onclick={() => edit(f)}><Pencil size={13} /></button
              >
              <button
                type="button"
                class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2 hover:text-danger"
                aria-label="Remove {f.label}"
                title="Remove (history is kept)"
                onclick={() => askRemove(f)}><Archive size={13} /></button
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
        {archived.length} removed field{archived.length === 1 ? '' : 's'}
      </button>
      {#if showArchived}
        <ul class="mt-2 flex flex-col divide-y divide-line rounded-lg border border-line">
          {#each archived as f (f.id)}
            <li class="flex items-center gap-2 px-3 py-2 text-muted">
              <span class="flex-1"
                >{f.label} <span class="text-xs">· {PERIOD_LABEL[f.period]}</span></span
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

<AggFieldEditor
  bind:open={editorOpen}
  field={editing}
  {isNew}
  {taken}
  locked={!isNew && !!editing && locked(editing.id)}
  onsubmit={put}
/>

<Dialog bind:open={removeOpen} title="Remove “{removing?.label ?? ''}”?" size="sm">
  <p class="text-sm text-muted">
    No one can add to it any more, and it leaves the cards and the composer. Its history is kept —
    every total stays in Analytics — and you can restore it.
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (removeOpen = false)}>Cancel</Button>
    <Button
      variant="danger"
      onclick={() => {
        if (removing) setArchived(removing, true);
        removeOpen = false;
      }}>Remove</Button
    >
  {/snippet}
</Dialog>

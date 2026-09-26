<!--
  Field editor (app.json components › Field editor): Name · Type · Options ·
  Required · Show on card. The type is chosen once — values are stored under
  the field's id in the type's shape, so changing it later would strand them
  (make a new field instead). Hands the finished FieldDef back; the Custom
  fields section saves the list.
-->
<script lang="ts" module>
  import type { FieldType } from '@tm/shared';
  export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
    text: 'Text',
    longText: 'Long text',
    number: 'Number',
    currency: 'Currency',
    percent: 'Percent',
    select: 'Single select',
    multiSelect: 'Multi select',
    checkbox: 'Checkbox',
    rating: 'Rating',
    date: 'Date',
    dateRange: 'Date range',
    person: 'Person',
    people: 'People',
    url: 'URL',
    email: 'Email',
    phone: 'Phone',
    ticketRelation: 'Related tickets',
    formula: 'Formula',
  };
</script>

<script lang="ts">
  import { FIELD_TYPES, type FieldDef, type Option } from '@tm/shared';
  import Button from '$lib/ui/Button.svelte';
  import Checkbox from '$lib/ui/Checkbox.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';
  import OptionListEditor from './OptionListEditor.svelte';

  interface Props {
    open: boolean;
    /** The field being edited; a new one has `isNew`. */
    field: FieldDef | null;
    isNew: boolean;
    /** Other fields' names (lower-cased) — names must be unique. */
    taken: string[];
    onsubmit: (def: FieldDef) => void;
  }
  let { open = $bindable(false), field, isNew, taken, onsubmit }: Props = $props();

  let f = $state<FieldDef | null>(null);
  $effect(() => {
    if (open && field) f = JSON.parse(JSON.stringify(field)) as FieldDef;
  });

  // Formula is computed server-side (phase 3): not offered for new fields.
  const TYPES = FIELD_TYPES.filter((t) => t !== 'formula');
  const hasOptions = $derived(f?.type === 'select' || f?.type === 'multiSelect');
  const nameTaken = $derived(!!f && taken.includes(f.name.trim().toLowerCase()));
  const valid = $derived(
    !!f && f.name.trim().length > 0 && !nameTaken && (!hasOptions || (f.options?.length ?? 0) > 0),
  );

  function setType(t: FieldType) {
    if (!f) return;
    const next: FieldDef = { ...f, type: t };
    if (t === 'select' || t === 'multiSelect') next.options = f.options ?? [];
    else delete next.options;
    next.config =
      t === 'currency'
        ? { currency: 'USD', precision: 2 }
        : t === 'rating'
          ? { max: 5 }
          : t === 'number' || t === 'percent'
            ? { precision: 0 }
            : undefined;
    if (!next.config) delete next.config;
    f = next;
  }
  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!f || !valid) return;
    onsubmit({ ...f, name: f.name.trim() });
    open = false;
  }
</script>

<Dialog bind:open title={isNew ? 'New custom field' : `Edit “${field?.name ?? ''}”`} size="md">
  {#if f}
    <form id="field-editor" class="flex flex-col gap-4" onsubmit={submit}>
      <Input
        label="Name"
        value={f.name}
        maxlength={60}
        required
        autofocus
        error={nameTaken ? 'Another field already has this name' : null}
        oninput={(e) => (f = { ...f!, name: e.currentTarget.value })}
      />
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Type</span>
        <select
          class="h-9 rounded-md border border-line bg-surface px-2 disabled:opacity-70"
          value={f.type}
          disabled={!isNew}
          onchange={(e) => setType(e.currentTarget.value as FieldType)}
        >
          {#each isNew ? TYPES : FIELD_TYPES as t (t)}<option value={t}
              >{FIELD_TYPE_LABEL[t]}</option
            >{/each}
        </select>
        {#if !isNew}<span class="text-xs text-muted"
            >The type can't change once a field exists — its values are stored in that shape.</span
          >{/if}
      </label>

      {#if hasOptions}
        <div class="flex flex-col gap-1.5">
          <span class="text-sm font-medium">Options</span>
          <OptionListEditor
            label="Options"
            items={f.options ?? []}
            addLabel="Add option"
            onchange={(xs: Option[]) => (f = { ...f!, options: xs })}
          />
          {#if !f.options?.length}<span class="text-xs text-danger">Add at least one option.</span
            >{/if}
        </div>
      {/if}
      {#if f.type === 'currency'}
        <Input
          label="Currency"
          value={f.config?.currency ?? 'USD'}
          maxlength={3}
          class="w-32"
          hint="ISO code, e.g. USD, EUR, INR."
          oninput={(e) =>
            (f = {
              ...f!,
              config: { ...f!.config, currency: e.currentTarget.value.toUpperCase() },
            })}
        />
      {/if}
      {#if f.type === 'number' || f.type === 'currency' || f.type === 'percent'}
        <Input
          label="Decimal places"
          type="number"
          min={0}
          max={10}
          value={f.config?.precision ?? 0}
          class="w-32"
          oninput={(e) =>
            (f = {
              ...f!,
              config: {
                ...f!.config,
                precision: Math.max(
                  0,
                  Math.min(10, Math.floor(Number(e.currentTarget.value) || 0)),
                ),
              },
            })}
        />
      {/if}
      {#if f.type === 'rating'}
        <Input
          label="Maximum"
          type="number"
          min={1}
          max={10}
          value={f.config?.max ?? 5}
          class="w-32"
          oninput={(e) =>
            (f = {
              ...f!,
              config: {
                ...f!.config,
                max: Math.max(1, Math.min(10, Math.floor(Number(e.currentTarget.value) || 5))),
              },
            })}
        />
      {/if}

      <Checkbox
        label="Required"
        description="New tickets must fill it in (quick add opens the full form)."
        checked={f.required ?? false}
        onchange={(e) => (f = { ...f!, required: e.currentTarget.checked })}
      />
      <Checkbox
        label="Show on card"
        description="Adds it to the card fields of new views."
        checked={f.showOnCard ?? false}
        onchange={(e) => (f = { ...f!, showOnCard: e.currentTarget.checked })}
      />
    </form>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" type="submit" form="field-editor" disabled={!valid}
      >{isNew ? 'Add field' : 'Done'}</Button
    >
  {/snippet}
</Dialog>

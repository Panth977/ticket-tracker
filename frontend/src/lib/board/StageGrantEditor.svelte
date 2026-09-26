<!--
  A commenter's StageGrant: the stages they may move tickets BETWEEN, and
  optionally only tickets assigned to them. No stages = no grant (read + comment only).
  <StageGrantEditor {stages} grant={m.stageGrant} onchange={(g) => …} />
-->
<script lang="ts">
  import type { Stage, StageGrant } from '@tm/shared';
  import ChoicePicker from '$lib/views/pickers/ChoicePicker.svelte';

  interface Props {
    stages: Stage[];
    grant: StageGrant | null | undefined;
    disabled?: boolean;
    /** null = remove the grant. */
    onchange: (grant: StageGrant | null) => void;
    label?: string;
  }
  let {
    stages,
    grant,
    disabled = false,
    onchange,
    label = 'Stages they may move tickets between',
  }: Props = $props();

  const items = $derived(
    [...stages]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ id: s.id, label: s.name, color: s.color })),
  );
  const selected = $derived(grant?.stages ?? []);

  function set(ids: string[], assignedOnly = grant?.assignedOnly ?? false) {
    onchange(ids.length ? { stages: ids, ...(assignedOnly ? { assignedOnly: true } : {}) } : null);
  }
</script>

<div class="flex flex-wrap items-center gap-2 text-xs">
  <ChoicePicker
    {items}
    {selected}
    multi
    placeholder="No stages"
    {label}
    {disabled}
    onchange={(ids) => set(ids)}
  />
  {#if selected.length}
    <label class="flex items-center gap-1 text-muted">
      <input
        type="checkbox"
        class="size-3.5 accent-[var(--tm-accent)]"
        checked={grant?.assignedOnly ?? false}
        {disabled}
        onchange={(e) => set(selected, e.currentTarget.checked)}
      />
      only their tickets
    </label>
  {/if}
</div>

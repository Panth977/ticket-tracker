<!--
  One table cell from the board script's previewTicketTable (board-script.html §table):
  text (a button that opens the ticket in an `open` column), a static h.* tree, or
  a ui.* control edited in place (its change goes through onFieldChange).
-->
<script lang="ts">
  import type { PickOption } from '$lib/ticket/fields/OptionPicker.svelte';
  import { createRenderer, type Renderer } from './render';
  import { mountPerson } from './mountPerson';
  import ScriptControls from './ScriptControls.svelte';
  import type { ScriptCell } from './script';

  interface Props {
    cell: ScriptCell;
    open?: () => void;
    disabled: boolean;
    people: PickOption[];
    tz: string;
    onchange: (c: { id: string; value: unknown; allDay?: boolean }) => void;
  }
  let { cell, open, disabled, people, tz, onchange }: Props = $props();

  let root: HTMLDivElement | undefined = $state();
  let renderer = $state<Renderer | null>(null);
  $effect(() => {
    if (!root) return;
    const r = createRenderer(root, { person: mountPerson });
    renderer = r;
    return () => r.destroy();
  });
  $effect(() => {
    if (renderer && cell.kind === 'tree') renderer.update(cell.tree, 0);
  });
</script>

{#if cell.kind === 'text'}
  {#if open}
    <button
      type="button"
      class="min-w-0 flex-1 truncate text-left hover:text-accent hover:underline"
      onclick={open}>{cell.text}</button
    >
  {:else}
    <span class="min-w-0 flex-1 truncate">{cell.text}</span>
  {/if}
{:else if cell.kind === 'control'}
  <ScriptControls layout="cell" controls={[cell.control]} {people} {tz} {disabled} {onchange} />
{:else}
  <div
    bind:this={root}
    class="tm-template-card min-w-0 flex-1 truncate {open ? 'cursor-pointer' : ''}"
    role={open ? 'button' : undefined}
    tabindex={open ? 0 : undefined}
    onclick={open}
    onkeydown={(e) => open && e.key === 'Enter' && open()}
  ></div>
{/if}

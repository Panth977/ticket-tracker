<!--
  A colour dot, or a palette picker when `options` is given (stages, tags,
  board colour).
  <ColorSwatch color={stage.color} />
  <ColorSwatch bind:value={color} options={PALETTE} label="Colour" />
-->
<script lang="ts" module>
  /** The board palette: readable in both themes. */
  export const PALETTE = [
    '#6b7280',
    '#ef4444',
    '#f97316',
    '#eab308',
    '#22c55e',
    '#14b8a6',
    '#3b82f6',
    '#6366f1',
    '#a855f7',
    '#ec4899',
    '#8b5e3c',
    '#0ea5e9',
  ];
</script>

<script lang="ts">
  import { Check } from 'lucide-svelte';

  interface Props {
    color?: string | null;
    value?: string | null;
    options?: string[];
    label?: string;
    size?: number;
    onchange?: (color: string) => void;
    class?: string;
  }
  let {
    color,
    value = $bindable(null),
    options,
    label = 'Colour',
    size = 12,
    onchange,
    class: cls = '',
  }: Props = $props();
</script>

{#if options}
  <div class="flex flex-wrap gap-1.5 {cls}" role="radiogroup" aria-label={label}>
    {#each options as c (c)}
      <button
        type="button"
        role="radio"
        aria-checked={value === c}
        aria-label={c}
        title={c}
        onclick={() => {
          value = c;
          onchange?.(c);
        }}
        class="grid size-6 place-items-center rounded-full ring-offset-2 ring-offset-surface transition
          {value === c ? 'ring-2 ring-text' : 'hover:scale-110'}"
        style="background:{c}"
      >
        {#if value === c}<Check size={13} color="white" aria-hidden="true" />{/if}
      </button>
    {/each}
  </div>
{:else}
  <span
    class="inline-block shrink-0 rounded-full {cls}"
    style="width:{size}px;height:{size}px;background:{color ?? 'var(--tm-subtle)'}"
    aria-hidden="true"
  ></span>
{/if}

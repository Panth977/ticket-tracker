<!-- A colour dot that opens the palette in a popover. -->
<script lang="ts">
  import ColorSwatch, { PALETTE } from '$lib/ui/ColorSwatch.svelte';
  import Popover from '$lib/ui/Popover.svelte';

  interface Props {
    value: string | null | undefined;
    label?: string;
    disabled?: boolean;
    onchange: (color: string) => void;
  }
  let { value, label = 'Colour', disabled = false, onchange }: Props = $props();
  let open = $state(false);
  let btn: HTMLButtonElement | null = $state(null);
</script>

<button
  bind:this={btn}
  type="button"
  class="grid size-7 shrink-0 place-items-center rounded hover:bg-surface-2 disabled:hover:bg-transparent"
  aria-label={label}
  aria-haspopup="dialog"
  aria-expanded={open}
  {disabled}
  onclick={() => (open = !open)}
>
  <ColorSwatch color={value} size={14} />
</button>
<Popover
  bind:open
  anchor={btn}
  {label}
  class="w-56 rounded-lg border border-line bg-surface p-3 shadow-pop"
>
  <ColorSwatch
    value={value ?? null}
    options={PALETTE}
    {label}
    onchange={(c) => {
      onchange(c);
      open = false;
    }}
  />
</Popover>

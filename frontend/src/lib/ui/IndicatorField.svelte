<!--
  @component
  indicators.html — the form control: the current mark and "Change", which
  opens the IndicatorPicker in a popover (it stays open while you pick, so an
  icon can be tinted; outside click or Escape closes it).

  ```svelte
  <IndicatorField bind:value={indicator} seed={name} />
  ```
-->
<script lang="ts">
  import { defaultIndicator, type Indicator } from '@tm/shared';
  import Indicator_ from './Indicator.svelte';
  import IndicatorPicker from './IndicatorPicker.svelte';
  import Popover from './Popover.svelte';

  interface Props {
    value?: Indicator;
    seed?: string;
    label?: string;
    disabled?: boolean;
    onchange?: (i: Indicator) => void;
  }
  let {
    value = $bindable(),
    seed = '',
    label = 'Indicator',
    disabled = false,
    onchange,
  }: Props = $props();

  let open = $state(false);
  let btn: HTMLButtonElement | undefined = $state();
  const shown = $derived(value ?? defaultIndicator(seed));
</script>

<button
  bind:this={btn}
  type="button"
  data-testid="indicator-field"
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-label="{label}: change"
  {disabled}
  onclick={() => (open = !open)}
  class="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5 text-sm outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
>
  <Indicator_ indicator={shown} size="lg" />
  <span class="text-muted">Change</span>
</button>

<Popover bind:open anchor={btn} {label} class="z-50">
  <IndicatorPicker
    value={shown}
    {seed}
    onchange={(i) => {
      value = i;
      onchange?.(i);
    }}
  />
</Popover>

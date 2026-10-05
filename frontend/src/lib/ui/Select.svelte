<!-- <Select label="Role" options={[{ value: 'editor', label: 'Editor' }]} bind:value={role} /> -->
<script lang="ts" generics="V extends string">
  import type { HTMLSelectAttributes } from 'svelte/elements';
  import Field from './Field.svelte';
  import Indicator from './Indicator.svelte';
  import { uid } from './ids';
  import type { Option } from './types';

  interface Props extends Omit<HTMLSelectAttributes, 'value'> {
    value?: V | null;
    options: Option<V>[];
    label?: string;
    hint?: string;
    error?: string | null;
    placeholder?: string;
    class?: string;
  }
  let {
    value = $bindable(null),
    options,
    label,
    hint,
    error,
    placeholder,
    id = uid('sel'),
    required,
    class: cls = '',
    ...rest
  }: Props = $props();
  const mark = $derived(options.find((o) => o.value === value)?.indicator ?? null);
  const marked = $derived(options.some((o) => o.indicator));
</script>

<Field id={id ?? ''} {label} {hint} {error} required={!!required} class={cls}>
  <div class="relative">
    {#if mark}<span
        class="pointer-events-none absolute inset-y-0 left-2 flex items-center"
        data-select-indicator
        ><Indicator
          indicator={mark.indicator}
          of={mark.of}
          seed={mark.seed}
          fallback={mark.fallback}
          size="sm"
        /></span
      >{/if}
    <select
      {id}
      bind:value
      {required}
      aria-invalid={error ? true : undefined}
      class="h-8 w-full rounded-md border border-line bg-surface text-sm text-text focus:border-accent focus:outline-none {marked
        ? 'pr-2 pl-8'
        : 'px-2'}"
      {...rest}
    >
      {#if placeholder}<option value={null} disabled>{placeholder}</option>{/if}
      {#each options as o (o.value)}
        <option value={o.value} disabled={o.disabled}>{o.label}</option>
      {/each}
    </select>
  </div>
</Field>

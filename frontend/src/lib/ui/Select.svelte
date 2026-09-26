<!-- <Select label="Role" options={[{ value: 'editor', label: 'Editor' }]} bind:value={role} /> -->
<script lang="ts" generics="V extends string">
  import type { HTMLSelectAttributes } from 'svelte/elements';
  import Field from './Field.svelte';
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
</script>

<Field id={id ?? ''} {label} {hint} {error} required={!!required} class={cls}>
  <select
    {id}
    bind:value
    {required}
    aria-invalid={error ? true : undefined}
    class="h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-text focus:border-accent focus:outline-none"
    {...rest}
  >
    {#if placeholder}<option value={null} disabled>{placeholder}</option>{/if}
    {#each options as o (o.value)}
      <option value={o.value} disabled={o.disabled}>{o.label}</option>
    {/each}
  </select>
</Field>

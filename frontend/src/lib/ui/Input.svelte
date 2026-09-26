<!-- <Input label="Display name" bind:value={name} error={err} /> -->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import Field from './Field.svelte';
  import { uid } from './ids';

  interface Props extends Omit<HTMLInputAttributes, 'value'> {
    value?: string | number | null;
    label?: string;
    hint?: string;
    error?: string | null;
    class?: string;
    inputClass?: string;
    ref?: HTMLInputElement | null;
  }
  let {
    value = $bindable(''),
    label,
    hint,
    error,
    id = uid('in'),
    required,
    class: cls = '',
    inputClass = '',
    ref = $bindable(null),
    ...rest
  }: Props = $props();
</script>

<Field id={id ?? ''} {label} {hint} {error} required={!!required} class={cls}>
  <input
    bind:this={ref}
    {id}
    bind:value
    {required}
    aria-invalid={error ? true : undefined}
    aria-describedby={error || hint ? `${id}-msg` : undefined}
    class="h-8 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-text placeholder:text-subtle
      focus:border-accent focus:outline-none aria-invalid:border-danger disabled:opacity-60 {inputClass}"
    {...rest}
  />
</Field>

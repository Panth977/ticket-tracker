<!-- <Textarea label="Message" bind:value={msg} rows={3} autosize /> -->
<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements';
  import Field from './Field.svelte';
  import { uid } from './ids';

  interface Props extends Omit<HTMLTextareaAttributes, 'value'> {
    value?: string | null;
    label?: string;
    hint?: string;
    error?: string | null;
    /** Grow with the content. */
    autosize?: boolean;
    class?: string;
  }
  let {
    value = $bindable(''),
    label,
    hint,
    error,
    autosize = false,
    id = uid('ta'),
    required,
    rows = 3,
    class: cls = '',
    ...rest
  }: Props = $props();

  let el: HTMLTextAreaElement | undefined = $state();
  $effect(() => {
    void value;
    if (autosize && el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  });
</script>

<Field id={id ?? ''} {label} {hint} {error} required={!!required} class={cls}>
  <textarea
    bind:this={el}
    {id}
    bind:value
    {rows}
    {required}
    aria-invalid={error ? true : undefined}
    aria-describedby={error || hint ? `${id}-msg` : undefined}
    class="w-full resize-y rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-text placeholder:text-subtle
      focus:border-accent focus:outline-none aria-invalid:border-danger"
    {...rest}></textarea>
</Field>

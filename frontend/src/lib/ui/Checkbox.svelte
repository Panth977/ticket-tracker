<!-- <Checkbox bind:checked={allowDelete} label="Allow permanent delete" /> -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { uid } from './ids';

  interface Props extends Omit<HTMLInputAttributes, 'type' | 'checked'> {
    checked?: boolean;
    indeterminate?: boolean;
    label?: string;
    description?: string;
    children?: Snippet;
    class?: string;
  }
  let {
    checked = $bindable(false),
    indeterminate = false,
    label,
    description,
    id = uid('cb'),
    children,
    class: cls = '',
    ...rest
  }: Props = $props();
</script>

<div class="flex items-start gap-2 {cls}">
  <input
    {id}
    type="checkbox"
    bind:checked
    {indeterminate}
    class="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-line-strong accent-[var(--tm-accent)]"
    {...rest}
  />
  {#if label || children || description}
    <label for={id} class="cursor-pointer text-sm leading-5 select-none">
      {#if children}{@render children()}{:else}{label}{/if}
      {#if description}<span class="block text-xs text-muted">{description}</span>{/if}
    </label>
  {/if}
</div>

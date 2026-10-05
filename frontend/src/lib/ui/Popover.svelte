<!--
  An anchored floating panel. Closes on Escape and outside click.
  <Popover bind:open anchor={btn}>…</Popover>
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { clickOutside, float, type Placement } from './floating';

  interface Props {
    open: boolean;
    anchor: HTMLElement | null | undefined;
    placement?: Placement;
    class?: string;
    role?: string;
    label?: string;
    onclose?: () => void;
    children: Snippet;
  }
  let {
    open = $bindable(false),
    anchor,
    placement = 'bottom-start',
    class: cls = '',
    role = 'dialog',
    label,
    onclose,
    children,
  }: Props = $props();

  function close() {
    open = false;
    onclose?.();
  }
  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      // Inside a modal <dialog>, Escape would also close the dialog (its default action).
      e.preventDefault();
      close();
      anchor?.focus();
    }
  }
</script>

{#if open}
  <div
    use:float={{ anchor, placement }}
    use:clickOutside={{ fn: close, also: anchor }}
    {role}
    aria-label={label}
    tabindex="-1"
    {onkeydown}
    class="tm-pop rounded-lg border border-line bg-surface text-text shadow-pop {cls}"
  >
    {@render children()}
  </div>
{/if}

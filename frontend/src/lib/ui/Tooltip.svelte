<!-- <Tooltip text="Archive (e)"><IconButton … /></Tooltip> — shows on hover and keyboard focus. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { float, type Placement } from './floating';
  import { uid } from './ids';

  interface Props {
    text: string;
    placement?: Placement;
    delay?: number;
    children: Snippet;
  }
  let { text, placement = 'top', delay = 400, children }: Props = $props();

  const id = uid('tip');
  let anchor: HTMLElement | null = $state(null);
  let show = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function enter() {
    clearTimeout(timer);
    timer = setTimeout(() => (show = true), delay);
  }
  function leave() {
    clearTimeout(timer);
    show = false;
  }
</script>

<span
  bind:this={anchor}
  class="inline-flex"
  role="presentation"
  aria-describedby={show ? id : undefined}
  onpointerenter={enter}
  onpointerleave={leave}
  onfocusin={enter}
  onfocusout={leave}
  onkeydown={(e) => e.key === 'Escape' && leave()}
>
  {@render children()}
</span>
{#if show && text}
  <div
    {id}
    role="tooltip"
    use:float={{ anchor, placement }}
    class="pointer-events-none max-w-64 rounded-md bg-text px-2 py-1 text-xs text-bg shadow-pop"
  >
    {text}
  </div>
{/if}

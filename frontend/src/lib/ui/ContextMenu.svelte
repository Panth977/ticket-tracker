<!--
  A right-click menu: the same Menu, anchored to the pointer instead of a
  button. One per page; open it from an `oncontextmenu` with the items for
  what was clicked:
    let ctx: ContextMenu;
    <div oncontextmenu={(e) => ctx.show(e, items)}>
    <ContextMenu bind:this={ctx} />
-->
<script lang="ts">
  import { tick } from 'svelte';
  import Menu from './Menu.svelte';
  import type { MenuItem } from './types';

  let open = $state(false);
  let items = $state<MenuItem[]>([]);
  let x = $state(0);
  let y = $state(0);

  /** Open at the event's pointer. An empty list leaves the browser's own menu. */
  export async function show(e: MouseEvent, list: MenuItem[]): Promise<void> {
    if (!list.length) return;
    e.preventDefault();
    e.stopPropagation();
    open = false;
    await tick();
    items = list;
    x = e.clientX;
    y = e.clientY;
    open = true;
  }
</script>

<Menu {items} bind:open placement="bottom-start">
  {#snippet trigger(p)}
    <!-- The anchor: a zero-size point where the pointer was (never shown, never tabbed to). -->
    <button
      type="button"
      {...p}
      tabindex="-1"
      aria-hidden="true"
      data-context-anchor
      class="pointer-events-none fixed size-0 opacity-0"
      style:left="{x}px"
      style:top="{y - 6}px"
    ></button>
  {/snippet}
</Menu>

<!--
  A side sheet on the native <dialog>: the ☰ sidebar on phones, the ticket
  drawer, filters. `modal={false}` renders it inline without a backdrop.
  <Drawer bind:open side="right" width="min(720px, 100vw)" label="Ticket">…</Drawer>
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    open: boolean;
    side?: 'left' | 'right';
    width?: string;
    label: string;
    onclose?: () => void;
    children: Snippet;
    class?: string;
  }
  let {
    open = $bindable(false),
    side = 'right',
    width = '420px',
    label,
    onclose,
    children,
    class: cls = '',
  }: Props = $props();

  let el: HTMLDialogElement | undefined = $state();
  /**
    A press on the ::backdrop targets the <dialog> itself. It only closes the
    sheet when the press STARTED there: the compatibility click that follows a
    tap lands wherever the finger was, and on a phone that is often this sheet,
    which would shut it in the same tap that opened it (§U2).
  */
  let pressedBackdrop = false;
  $effect(() => {
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  });
  function handleClose() {
    if (open) {
      open = false;
      onclose?.();
    }
  }
</script>

<dialog
  bind:this={el}
  aria-label={label}
  onclose={handleClose}
  onpointerdown={(e) => (pressedBackdrop = e.target === el)}
  onclick={(e) => {
    if (e.target !== el || !pressedBackdrop) return;
    pressedBackdrop = false;
    el?.close();
  }}
  style="width: {width}; max-width: 100vw;"
  class="fixed inset-y-0 m-0 h-dvh max-h-dvh border-line bg-surface p-0 text-text shadow-pop
    {side === 'left'
    ? 'tm-sheet-left right-auto left-0 border-r'
    : 'tm-sheet-right right-0 left-auto border-l'} {cls}"
>
  {#if open}
    <div class="tm-safe-top tm-safe-bottom h-full overflow-y-auto">{@render children()}</div>
  {/if}
</dialog>

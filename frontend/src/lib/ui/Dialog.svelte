<!--
  Modal dialog on the native <dialog> (focus trap, Escape, inert background).
  <Dialog bind:open title="Delete board?" description="This cannot be undone.">
    …body…
    {#snippet footer()}<Button onclick={…}>Delete</Button>{/snippet}
  </Dialog>
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from 'lucide-svelte';
  import IconButton from './IconButton.svelte';
  import { uid } from './ids';

  interface Props {
    open: boolean;
    title?: string;
    description?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    /** false = clicking the backdrop does not close. */
    dismissible?: boolean;
    onclose?: () => void;
    children?: Snippet;
    footer?: Snippet;
  }
  let {
    open = $bindable(false),
    title,
    description,
    size = 'md',
    dismissible = true,
    onclose,
    children,
    footer,
  }: Props = $props();

  const id = uid('dlg');
  let el: HTMLDialogElement | undefined = $state();
  const width = $derived(
    { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size],
  );

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
  function onBackdrop(e: MouseEvent) {
    if (dismissible && e.target === el) el?.close();
  }
</script>

<dialog
  bind:this={el}
  onclose={handleClose}
  onclick={onBackdrop}
  aria-labelledby={title ? `${id}-t` : undefined}
  aria-describedby={description ? `${id}-d` : undefined}
  class="tm-dialog m-auto w-[calc(100%-2rem)] {width} rounded-xl border border-line bg-surface p-0 text-text shadow-pop"
>
  {#if open}
    <div class="flex max-h-[85dvh] flex-col">
      {#if title}
        <header class="flex items-start gap-3 px-5 pt-4 pb-2">
          <div class="flex-1">
            <h2 id="{id}-t" class="text-base font-semibold">{title}</h2>
            {#if description}<p id="{id}-d" class="mt-0.5 text-sm text-muted">{description}</p>{/if}
          </div>
          <IconButton icon={X} label="Close" size="sm" onclick={() => el?.close()} />
        </header>
      {/if}
      <div class="flex-1 overflow-y-auto px-5 py-3">{@render children?.()}</div>
      {#if footer}
        <footer class="flex justify-end gap-2 border-t border-line px-5 py-3">
          {@render footer()}
        </footer>
      {/if}
    </div>
  {/if}
</dialog>

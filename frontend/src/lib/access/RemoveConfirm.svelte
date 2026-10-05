<!-- "Remove X?" — the one confirmation both access lists use. -->
<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import EntityLabel from './EntityLabel.svelte';
  import type { EntityView } from './entities';

  interface Props {
    open: boolean;
    entity: EntityView | null;
    /** What happens, in one or two sentences. */
    message: string;
    onconfirm: () => Promise<boolean>;
  }
  let { open = $bindable(false), entity, message, onconfirm }: Props = $props();
  let busy = $state(false);

  async function go() {
    busy = true;
    const ok = await onconfirm();
    busy = false;
    if (ok) open = false;
  }
</script>

<Dialog bind:open title="Remove access?" size="sm">
  <div class="flex flex-col gap-3 text-sm">
    {#if entity}
      <div class="rounded-lg bg-surface-2 px-3 py-2"><EntityLabel {entity} showKind /></div>
    {/if}
    <p class="text-muted">{message}</p>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="danger" loading={busy} onclick={go}>Remove</Button>
  {/snippet}
</Dialog>

<!--
  Move to… (memory.html §F): every folder of the memory (the root first),
  except the node itself and what is inside it. A folder moves with its whole
  subtree (memoryMove rewrites the paths).
-->
<script lang="ts">
  import { Folder, Home } from 'lucide-svelte';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import { folderPaths, memoryParentPath, type Node } from './tree';

  interface Props {
    open: boolean;
    node: Node | null;
    nodes: readonly Node[];
    onsubmit: (folder: string) => Promise<boolean>;
  }
  let { open = $bindable(false), node, nodes, onsubmit }: Props = $props();

  const folders = $derived(
    node ? folderPaths(nodes, node.kind === 'folder' ? node.path : null) : [],
  );
  let chosen = $state('');
  let busy = $state(false);

  $effect(() => {
    if (open && node) chosen = memoryParentPath(node.path);
  });

  async function submit() {
    if (busy || !node) return;
    busy = true;
    try {
      if (await onsubmit(chosen)) open = false;
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  title="Move {node?.name ?? ''}"
  size="sm"
  description="Pick the folder it goes into."
>
  <ul class="flex max-h-80 flex-col gap-px overflow-y-auto" role="listbox" aria-label="Folders">
    {#each folders as f (f)}
      {@const depth = f ? f.split('/').length : 0}
      <li>
        <button
          type="button"
          role="option"
          aria-selected={chosen === f}
          class="flex h-8 w-full min-w-0 items-center gap-2 rounded-md pr-2 text-left text-sm {chosen ===
          f
            ? 'bg-accent-soft font-medium text-text'
            : 'text-muted hover:bg-surface-2 hover:text-text'}"
          style:padding-left="{0.5 + depth * 0.9}rem"
          onclick={() => (chosen = f)}
        >
          {#if f}<Folder size={14} class="shrink-0" aria-hidden="true" />{:else}<Home
              size={14}
              class="shrink-0"
              aria-hidden="true"
            />{/if}
          <span class="truncate">{f ? f.slice(f.lastIndexOf('/') + 1) : 'Top level'}</span>
        </button>
      </li>
    {/each}
  </ul>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button
      variant="primary"
      loading={busy}
      disabled={!node || chosen === memoryParentPath(node.path)}
      onclick={submit}>Move here</Button
    >
  {/snippet}
</Dialog>

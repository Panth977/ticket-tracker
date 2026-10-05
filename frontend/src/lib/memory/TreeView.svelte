<!--
  TREE view (memory.html §F): an explorer tree. A folder row folds; a file row
  opens the file on the right. ⌘/Ctrl-click selects several (Delete n). Drag
  a node onto a folder to move it there; drop files from the desktop onto a
  folder (or the empty space below, = the top level) to upload into it.
-->
<script lang="ts">
  import { ChevronRight, Folder, FolderOpen, MoreHorizontal } from 'lucide-svelte';
  import Menu from '$lib/ui/Menu.svelte';
  import type { MenuItem } from '$lib/ui/types';
  import { KIND_ICON, kindOf } from '$lib/files/kinds';
  import Self from './TreeView.svelte';
  import type { Node, TreeNode } from './tree';

  interface Props {
    tree: TreeNode[];
    depth?: number;
    expanded: ReadonlySet<string>;
    current: string | null;
    selected: ReadonlySet<string>;
    writable: boolean;
    itemsFor: (node: Node) => MenuItem[];
    onopen: (node: Node) => void;
    ontoggle: (path: string) => void;
    onselect: (node: Node) => void;
    ondropfiles: (folder: string, dt: DataTransfer) => void;
    ondropnode: (nodeId: string, folder: string) => void;
  }
  let {
    tree,
    depth = 0,
    expanded,
    current,
    selected,
    writable,
    itemsFor,
    onopen,
    ontoggle,
    onselect,
    ondropfiles,
    ondropnode,
  }: Props = $props();

  const NODE_MIME = 'application/x-memory-node';
  let over = $state<string | null>(null);

  function drop(e: DragEvent, folder: string) {
    e.preventDefault();
    e.stopPropagation();
    over = null;
    if (!writable || !e.dataTransfer) return;
    const id = e.dataTransfer.getData(NODE_MIME);
    if (id) ondropnode(id, folder);
    else if (e.dataTransfer.files.length || e.dataTransfer.items.length)
      ondropfiles(folder, e.dataTransfer);
  }
  function dragOver(e: DragEvent, folder: string) {
    if (!writable) return;
    e.preventDefault();
    e.stopPropagation();
    over = folder;
  }
</script>

<ul role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? 'Files' : undefined}>
  {#each tree as t (t.node.id)}
    {@const n = t.node}
    {@const isFolder = n.kind === 'folder'}
    {@const open = isFolder && expanded.has(n.path)}
    {@const Icon = isFolder
      ? open
        ? FolderOpen
        : Folder
      : KIND_ICON[kindOf({ name: n.name, mime: n.file?.mime ?? '' })]}
    <li
      role="treeitem"
      aria-expanded={isFolder ? open : undefined}
      aria-selected={current === n.path || selected.has(n.id)}
    >
      <div
        class="group flex h-7 min-w-0 items-center gap-1 rounded-md pr-1 text-sm
          {current === n.path
          ? 'bg-surface-3 font-medium text-text'
          : selected.has(n.id)
            ? 'bg-accent-soft text-text'
            : over === n.path
              ? 'bg-accent-soft'
              : 'text-muted hover:bg-surface-2 hover:text-text'}"
        style:padding-left="{0.25 + depth * 0.85}rem"
        data-node={n.path}
        data-kind={n.kind}
        draggable={writable}
        ondragstart={(e) => e.dataTransfer?.setData(NODE_MIME, n.id)}
        ondragover={(e) => isFolder && dragOver(e, n.path)}
        ondragleave={() => over === n.path && (over = null)}
        ondrop={(e) => isFolder && drop(e, n.path)}
        role="none"
      >
        {#if isFolder}
          <button
            type="button"
            class="grid size-5 shrink-0 place-items-center text-subtle hover:text-text"
            aria-label="{open ? 'Fold' : 'Unfold'} {n.name}"
            onclick={() => ontoggle(n.path)}
          >
            <ChevronRight size={13} class="transition-transform {open ? 'rotate-90' : ''}" />
          </button>
        {:else}
          <span class="w-5 shrink-0"></span>
        {/if}
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onclick={(e) =>
            e.metaKey || e.ctrlKey ? onselect(n) : isFolder ? ontoggle(n.path) : onopen(n)}
          ondblclick={() => isFolder && onopen(n)}
        >
          <Icon size={14} class="shrink-0 {isFolder ? 'text-accent' : ''}" aria-hidden="true" />
          <span class="truncate">{n.name}</span>
        </button>
        <Menu items={itemsFor(n)} placement="bottom-end">
          {#snippet trigger(p)}
            <button
              type="button"
              {...p}
              class="grid size-6 shrink-0 place-items-center rounded text-subtle opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-text focus-visible:opacity-100 aria-expanded:opacity-100"
              aria-label="Actions for {n.name}"><MoreHorizontal size={14} /></button
            >
          {/snippet}
        </Menu>
      </div>
      {#if open && t.children.length}
        <Self
          tree={t.children}
          depth={depth + 1}
          {expanded}
          {current}
          {selected}
          {writable}
          {itemsFor}
          {onopen}
          {ontoggle}
          {onselect}
          {ondropfiles}
          {ondropnode}
        />
      {/if}
    </li>
  {/each}
</ul>
{#if depth === 0}
  <!-- The space below the tree: drop here = the top level. -->
  <div
    class="min-h-16 flex-1 rounded-md {over === '' ? 'bg-accent-soft' : ''}"
    ondragover={(e) => dragOver(e, '')}
    ondragleave={() => over === '' && (over = null)}
    ondrop={(e) => drop(e, '')}
    role="none"
    data-drop-root
  ></div>
{/if}

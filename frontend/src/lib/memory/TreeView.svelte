<!--
  TREE view (memory.html §F): an explorer tree. A folder row folds; a file row
  opens the file on the right. ⌘/Ctrl-click selects several (Delete n).
  Right-click a row for its menu, or the empty space for the top level's.
  F2 renames the focused row, Delete deletes it.

  Drag a node (or files from the desktop) over the tree: the folder it would
  land in lights up as a whole — its row and everything under it — and a
  folded one unfolds after a moment. Over a file, that is the file's folder;
  over the empty space, the top level (drag.svelte.ts).
-->
<script lang="ts">
  import { ChevronRight, Folder, FolderOpen, MoreHorizontal } from 'lucide-svelte';
  import Menu from '$lib/ui/Menu.svelte';
  import type { MenuItem } from '$lib/ui/types';
  import { KIND_ICON, kindOf } from '$lib/files/kinds';
  import { memoryDrag } from './drag.svelte';
  import Self from './TreeView.svelte';
  import { memoryParentPath, type Node, type TreeNode } from './tree';

  interface Props {
    tree: TreeNode[];
    depth?: number;
    expanded: ReadonlySet<string>;
    current: string | null;
    selected: ReadonlySet<string>;
    writable: boolean;
    itemsFor: (node: Node) => MenuItem[];
    /** Right-click: a node's menu, or (null) the top level's. */
    oncontext: (e: MouseEvent, node: Node | null) => void;
    onopen: (node: Node) => void;
    ontoggle: (path: string) => void;
    onselect: (node: Node) => void;
    onkey: (e: KeyboardEvent, node: Node) => void;
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
    oncontext,
    onopen,
    ontoggle,
    onselect,
    onkey,
    ondropfiles,
    ondropnode,
  }: Props = $props();

  const targetOf = (n: Node) => (n.kind === 'folder' ? n.path : memoryParentPath(n.path));

  function drop(e: DragEvent, folder: string) {
    const got = memoryDrag.take(e, folder, writable);
    if (!got) return;
    if ('nodeId' in got) ondropnode(got.nodeId, folder);
    else ondropfiles(folder, got.files);
  }

  // A folded folder held under a drag for a moment unfolds.
  let unfoldTimer: ReturnType<typeof setTimeout> | undefined;
  let unfolding: string | null = null;
  function hover(e: DragEvent, n: Node) {
    memoryDrag.hover(e, targetOf(n), writable);
    const want = n.kind === 'folder' && !expanded.has(n.path) ? n.path : null;
    if (want === unfolding) return;
    clearTimeout(unfoldTimer);
    unfolding = want;
    if (want)
      unfoldTimer = setTimeout(() => {
        if (memoryDrag.over === want && !expanded.has(want)) ontoggle(want);
        unfolding = null;
      }, 650);
  }
  $effect(() => () => clearTimeout(unfoldTimer));
</script>

{#snippet rows()}
  <ul role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? 'Files' : undefined}>
    {#each tree as t (t.node.id)}
      {@const n = t.node}
      {@const isFolder = n.kind === 'folder'}
      {@const open = isFolder && expanded.has(n.path)}
      {@const target = isFolder && memoryDrag.over === n.path}
      {@const Icon = isFolder
        ? open
          ? FolderOpen
          : Folder
        : KIND_ICON[kindOf({ name: n.name, mime: n.file?.mime ?? '' })]}
      <li
        role="treeitem"
        aria-expanded={isFolder ? open : undefined}
        aria-selected={current === n.path || selected.has(n.id)}
        class="rounded-md {target ? 'bg-accent-soft ring-1 ring-accent' : ''}"
        data-drop-target={target || undefined}
      >
        <div
          class="group flex h-7 min-w-0 items-center gap-1 rounded-md pr-1 text-sm
          {current === n.path
            ? 'bg-surface-3 font-medium text-text'
            : selected.has(n.id)
              ? 'bg-accent-soft text-text'
              : target
                ? 'font-medium text-text'
                : 'text-muted hover:bg-surface-2 hover:text-text'}
          {memoryDrag.node?.id === n.id ? 'opacity-50' : ''}"
          style:padding-left="{0.25 + depth * 0.85}rem"
          data-node={n.path}
          data-kind={n.kind}
          draggable={writable}
          ondragstart={(e) => memoryDrag.start(e, n)}
          ondragend={() => memoryDrag.end()}
          ondragover={(e) => hover(e, n)}
          ondrop={(e) => drop(e, targetOf(n))}
          oncontextmenu={(e) => oncontext(e, n)}
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
            onkeydown={(e) => onkey(e, n)}
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
            {oncontext}
            {onopen}
            {ontoggle}
            {onselect}
            {onkey}
            {ondropfiles}
            {ondropnode}
          />
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

{#if depth === 0}
  <!-- The whole tree is the top level's drop target; rows inside claim their own. -->
  <div
    class="flex min-h-full flex-1 flex-col rounded-md {memoryDrag.over === ''
      ? 'bg-accent-soft ring-1 ring-accent'
      : ''}"
    ondragover={(e) => memoryDrag.hover(e, '', writable)}
    ondrop={(e) => drop(e, '')}
    oncontextmenu={(e) => oncontext(e, null)}
    role="none"
    data-drop-root
    data-drop-target={memoryDrag.over === '' || undefined}
  >
    {@render rows()}
    <div class="min-h-16 flex-1"></div>
  </div>
{:else}
  {@render rows()}
{/if}

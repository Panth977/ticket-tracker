<!--
  FOLDERS view (memory.html §F): the current folder's contents as tiles —
  folders first, images with a thumbnail. A click on a folder goes in, on a
  file opens it. ⌘/Ctrl-click selects. Right-click a tile for its menu, or the
  empty space for this folder's. Drop files (or a tile) onto a folder tile to
  put them there — the tile lights up — or anywhere else for this folder
  itself, which lights up as a whole (drag.svelte.ts).
-->
<script lang="ts">
  import { Folder, MoreHorizontal } from 'lucide-svelte';
  import { formatBytes } from '@tm/shared';
  import { relativeTime } from '$lib/account/format';
  import { KIND_ICON, kindOf } from '$lib/files/kinds';
  import { fileUrl } from '$lib/files/source';
  import Menu from '$lib/ui/Menu.svelte';
  import type { MenuItem } from '$lib/ui/types';
  import { memoryDrag } from './drag.svelte';
  import type { Node } from './tree';

  interface Props {
    folder: string;
    children: Node[];
    /** Files under each folder child (the tile's count). */
    countOf: (folder: Node) => number;
    selected: ReadonlySet<string>;
    writable: boolean;
    itemsFor: (node: Node) => MenuItem[];
    /** Right-click: a node's menu, or (null) this folder's. */
    oncontext: (e: MouseEvent, node: Node | null) => void;
    onkey: (e: KeyboardEvent, node: Node) => void;
    onopen: (node: Node) => void;
    onselect: (node: Node) => void;
    ondropfiles: (folder: string, dt: DataTransfer) => void;
    ondropnode: (nodeId: string, folder: string) => void;
  }
  let {
    folder,
    children,
    countOf,
    selected,
    writable,
    itemsFor,
    oncontext,
    onkey,
    onopen,
    onselect,
    ondropfiles,
    ondropnode,
  }: Props = $props();

  function drop(e: DragEvent, target: string) {
    const got = memoryDrag.take(e, target, writable);
    if (!got) return;
    if ('nodeId' in got) ondropnode(got.nodeId, target);
    else ondropfiles(target, got.files);
  }
  const here = $derived(memoryDrag.over === folder);

  /** A thumbnail URL per image node, fetched once per version. */
  const thumbs = $state<Record<string, string | null>>({});
  $effect(() => {
    for (const n of children) {
      const f = n.file;
      if (!f || !f.mime.startsWith('image/') || f.storagePath in thumbs) continue;
      thumbs[f.storagePath] = null;
      void fileUrl(f.storagePath).then((u) => (thumbs[f.storagePath] = u));
    }
  });
</script>

<div
  class="min-h-full rounded-lg p-1 {here ? 'bg-accent-soft ring-2 ring-accent ring-inset' : ''}"
  ondragover={(e) => memoryDrag.hover(e, folder, writable)}
  ondrop={(e) => drop(e, folder)}
  oncontextmenu={(e) => oncontext(e, null)}
  role="none"
  data-folder-view={folder}
  data-drop-target={here || undefined}
>
  {#if !children.length}
    <p class="p-8 text-center text-sm text-muted">
      {writable ? 'This folder is empty. Drop files here, or use Upload.' : 'This folder is empty.'}
    </p>
  {:else}
    <ul class="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
      {#each children as n (n.id)}
        {@const isFolder = n.kind === 'folder'}
        {@const Icon = KIND_ICON[kindOf({ name: n.name, mime: n.file?.mime ?? '' })]}
        {@const thumb = n.file ? thumbs[n.file.storagePath] : null}
        {@const target = isFolder && memoryDrag.over === n.path}
        <li
          class="group relative flex flex-col overflow-hidden rounded-xl border bg-surface transition-colors
            {selected.has(n.id)
            ? 'border-accent ring-1 ring-accent'
            : target
              ? 'border-accent bg-accent-soft ring-2 ring-accent'
              : 'border-line hover:border-line-strong hover:bg-surface-2'}
            {memoryDrag.node?.id === n.id ? 'opacity-50' : ''}"
          data-node={n.path}
          data-kind={n.kind}
          data-drop-target={target || undefined}
          draggable={writable}
          ondragstart={(e) => memoryDrag.start(e, n)}
          ondragend={() => memoryDrag.end()}
          ondragover={(e) => memoryDrag.hover(e, isFolder ? n.path : folder, writable)}
          ondrop={(e) => drop(e, isFolder ? n.path : folder)}
          oncontextmenu={(e) => oncontext(e, n)}
        >
          <button
            type="button"
            class="flex flex-1 flex-col text-left focus-visible:outline-2 focus-visible:outline-accent"
            onclick={(e) => (e.metaKey || e.ctrlKey ? onselect(n) : onopen(n))}
            onkeydown={(e) => onkey(e, n)}
          >
            <span class="grid aspect-[4/3] place-items-center overflow-hidden bg-surface-2">
              {#if thumb}
                <img src={thumb} alt="" class="size-full object-cover" loading="lazy" />
              {:else if isFolder}
                <Folder size={34} strokeWidth={1.25} class="text-accent" aria-hidden="true" />
              {:else}
                <Icon size={30} strokeWidth={1.25} class="text-muted" aria-hidden="true" />
              {/if}
            </span>
            <span class="flex flex-col gap-0.5 px-2.5 py-2">
              <span class="truncate text-sm font-medium" title={n.name}>{n.name}</span>
              <span class="truncate text-xs text-subtle">
                {#if isFolder}{countOf(n)} {countOf(n) === 1 ? 'file' : 'files'}{:else}{formatBytes(
                    n.file?.size ?? 0,
                  )} · {relativeTime(n.updatedAt)}{/if}
              </span>
            </span>
          </button>
          <div class="absolute top-1.5 right-1.5">
            <Menu items={itemsFor(n)} placement="bottom-end">
              {#snippet trigger(p)}
                <button
                  type="button"
                  {...p}
                  class="grid size-7 place-items-center rounded-md bg-surface/90 text-muted opacity-0 shadow-sm group-hover:opacity-100 hover:text-text focus-visible:opacity-100 aria-expanded:opacity-100"
                  aria-label="Actions for {n.name}"><MoreHorizontal size={15} /></button
                >
              {/snippet}
            </Menu>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

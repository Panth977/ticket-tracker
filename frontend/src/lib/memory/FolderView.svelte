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
  import { fileIcon } from '$lib/files/fileIcons';
  import FilePreview from '$lib/files/FilePreview.svelte';
  import { visible } from '$lib/files/visible';
  import type { ViewerFile } from '$lib/files/types';
  import Menu from '$lib/ui/Menu.svelte';
  import type { MenuItem } from '$lib/ui/types';
  import { memoryDrag } from './drag.svelte';
  import type { Node } from './tree';

  interface Props {
    folder: string;
    children: Node[];
    /** Files under each folder child (the tile's count). */
    countOf: (folder: Node) => number;
    /** A folder tile's peek: its first few children. */
    peek: (folder: Node) => Node[];
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
    peek,
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

  /** Tiles that have come near the viewport: their previews load (and stay). */
  const seen = $state<Record<string, boolean>>({});
  const asViewer = (n: Node): ViewerFile | null =>
    n.file
      ? {
          id: n.id,
          path: n.file.storagePath,
          name: n.name,
          mime: n.file.mime,
          size: n.file.size,
          width: n.file.width,
          height: n.file.height,
          createdAt: n.updatedAt,
        }
      : null;
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
        {@const vf = asViewer(n)}
        {@const fi = isFolder ? null : fileIcon({ name: n.name, mime: n.file?.mime })}
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
          <!-- The preview may hold rich markup (Markdown, a page): a transparent button over it opens. -->
          <div
            class="relative aspect-[4/3] overflow-hidden bg-surface-2"
            use:visible={(on) => on && (seen[n.id] = true)}
          >
            {#if isFolder}
              {@const inside = peek(n)}
              <span class="flex size-full flex-col gap-1 p-2.5">
                <Folder
                  size={22}
                  strokeWidth={1.5}
                  class="shrink-0 text-accent"
                  aria-hidden="true"
                />
                {#each inside as c (c.id)}
                  {@const ci =
                    c.kind === 'folder' ? null : fileIcon({ name: c.name, mime: c.file?.mime })}
                  <span class="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
                    {#if ci}<ci.icon
                        size={12}
                        class="shrink-0 {ci.tone}"
                        aria-hidden="true"
                      />{:else}<Folder
                        size={12}
                        class="shrink-0 text-accent"
                        aria-hidden="true"
                      />{/if}
                    <span class="truncate">{c.name}</span>
                  </span>
                {:else}
                  <span class="text-[11px] text-subtle">Empty</span>
                {/each}
              </span>
            {:else if vf}
              <FilePreview file={vf} shown={!!seen[n.id]} iconSize={30} />
            {/if}
            <button
              type="button"
              class="absolute inset-0 size-full cursor-pointer focus-visible:outline-2 focus-visible:outline-accent"
              aria-label="Open {n.name}"
              onclick={(e) => (e.metaKey || e.ctrlKey ? onselect(n) : onopen(n))}
              onkeydown={(e) => onkey(e, n)}
            ></button>
          </div>
          <button
            type="button"
            class="flex min-w-0 items-center gap-2 px-2.5 py-2 text-left"
            tabindex="-1"
            onclick={(e) => (e.metaKey || e.ctrlKey ? onselect(n) : onopen(n))}
          >
            {#if fi}<fi.icon
                size={14}
                class="shrink-0 {fi.tone}"
                aria-hidden="true"
              />{:else}<Folder size={14} class="shrink-0 text-accent" aria-hidden="true" />{/if}
            <span class="flex min-w-0 flex-col gap-0.5">
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

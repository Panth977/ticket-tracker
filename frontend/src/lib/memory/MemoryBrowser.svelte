<!--
  ONE MEMORY (docs/plan/memory.html §F): its header (the same title dropdown
  as a board's, "Workspace ›" when entered through one), the Tree | Folders
  toggle (remembered per browser), and the open file or folder from ?path=.

    Tree     an explorer tree on the left; the open file (or folder's
             contents) on the right
    Folders  a breadcrumb and the folder's contents as tiles; a file opens
             full width under the same breadcrumb

  Uploads: drop files or folders anywhere (into the folder you are in, or the
  folder you drop on — it lights up, drag.svelte.ts), or pick them with Add,
  which asks for each file's path first (UploadDialog). Right-click anything
  (or the empty space) for its menu. Every change is a command; the node
  listener redraws.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { untrack } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    ArrowLeft,
    ChevronRight,
    Code2,
    Copy,
    Download,
    Eye,
    FilePlus,
    FolderInput,
    FolderPlus,
    FolderTree,
    FolderUp,
    Home,
    LayoutGrid,
    Lock,
    Pencil,
    Plus,
    SearchX,
    Settings,
    Share2,
    Trash2,
    Upload,
  } from 'lucide-svelte';
  import { MEMORY_DEFAULT_INDICATOR, formatBytes } from '@tm/shared';
  import { auth } from '$lib/firebase/auth.svelte';
  import { downloadFile } from '$lib/files/source';
  import { routes } from '$lib/layout/routes';
  import {
    Button,
    ContextMenu,
    Dialog,
    EmptyState,
    IconButton,
    Menu,
    Skeleton,
    toast,
  } from '$lib/ui';
  import type { MenuItem } from '$lib/ui/types';
  import { workspaceContext } from '$lib/workspaces/context.svelte';
  import { switcherFor } from '$lib/workspaces/switcherStore';
  import TitleSwitcher from '$lib/workspaces/TitleSwitcher.svelte';
  import WorkspaceCrumb from '$lib/workspaces/WorkspaceCrumb.svelte';
  import { copyPath, createFile, createFolder, deleteNodes, moveNode } from './actions';
  import { memoryDrag } from './drag.svelte';
  import FilePane from './FilePane.svelte';
  import FolderView from './FolderView.svelte';
  import MoveDialog from './MoveDialog.svelte';
  import NameDialog from './NameDialog.svelte';
  import UploadDialog from './UploadDialog.svelte';
  import {
    canManage,
    canWrite,
    memoryDoc,
    memoryNodes,
    memoryRoleIn,
    myReach,
    saveMemoryView,
    savedMemoryView,
    type FileMode,
    type MemoryView,
  } from './store';
  import {
    ancestorsOf,
    buildTree,
    childrenOf,
    crumbs,
    findByPath,
    freeName,
    memoryParentPath,
    movedPath,
    subtreeStats,
    uploadTarget,
    type Node,
  } from './tree';
  import TreeView from './TreeView.svelte';
  import UploadTray from './UploadTray.svelte';
  import { filesFromDrop, filesFromInput, memoryUploads } from './upload.svelte';

  let { memoryId }: { memoryId: string } = $props();

  const uid = $derived(auth.uid);
  const docQ = $derived(memoryDoc(memoryId));
  const mem = $derived($docQ.data);
  const nodesQ = $derived(memoryNodes(memoryId));
  const nodes = $derived($nodesQ.data as Node[]);
  const reach = $derived(myReach(mem ?? null, uid));
  // Archived = read-only for everyone, the owner included, until restored.
  const writable = $derived(canWrite(reach) && mem?.archivedAt == null);
  const role = $derived(memoryRoleIn(mem, uid));

  const switchQ = $derived(switcherFor(uid, { memoryId }, workspaceContext.id));

  // ── where I am: ?path= (a file or a folder; '' = the top level) ────────────
  const path = $derived(page.url.searchParams.get('path') ?? '');
  const openNode = $derived(path ? findByPath(nodes, path) : null);
  const openFile = $derived(openNode?.kind === 'file' ? openNode : null);
  /** The folder whose contents are shown (a file's folder when a file is open). */
  const folder = $derived(
    openNode ? (openNode.kind === 'folder' ? openNode.path : memoryParentPath(openNode.path)) : '',
  );
  // FOLLOW WHAT IS OPEN, by id: a move or rename — here, in another tab, by an
  // agent — changes its path (and every path under a moved folder), never its
  // id. So when ?path= stops naming anything but the node we had open is still
  // there under a new path, go there instead of saying it is gone.
  /** What ?path= showed last: the node, and the path it was at. */
  let shown = $state<{ id: string; path: string } | null>(null);
  $effect(() => {
    if (openNode) shown = { id: openNode.id, path: openNode.path };
    else if (!path) shown = null;
  });
  // Follow only when THIS path stopped naming the node it showed — not after
  // navigating to a path that is not there yet (an upload still landing).
  const movedTo = $derived(
    path && !openNode && shown && shown.path === path
      ? (nodes.find((n) => n.id === shown!.id)?.path ?? null)
      : null,
  );
  $effect(() => {
    if (movedTo !== null) go(movedTo, { replace: true });
  });
  const missing = $derived(!!path && !$nodesQ.loading && !openNode && movedTo === null);

  function go(p: string, opts: { mode?: FileMode; replace?: boolean } = {}) {
    if (opts.mode) mode = opts.mode;
    void goto(routes.memory(memoryId, p || null), {
      keepFocus: true,
      noScroll: true,
      replaceState: !!opts.replace,
    });
  }

  // ── view and mode ──────────────────────────────────────────────────────────
  let view = $state<MemoryView>(savedMemoryView());
  function setView(v: MemoryView) {
    view = v;
    saveMemoryView(v);
  }
  let mode = $state<FileMode>(page.url.searchParams.get('mode') === 'code' ? 'code' : 'preview');
  let dirty = $state(false);

  beforeNavigate((nav) => {
    if (dirty && !confirm('Leave without saving your changes to this file?')) nav.cancel();
  });
  $effect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  });

  // ── the tree's folds: OPENING something unfolds the path to it ─────────────
  // Only when what is open changes — not whenever the folds do, or a folder on
  // that path could never be folded again (it sprang back open).
  let expanded = $state<Set<string>>(new Set());
  const openKey = $derived(openNode ? `${openNode.kind}:${openNode.path}` : '');
  $effect(() => {
    const key = openKey;
    if (!key) return;
    const [kind, p] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const need = [...ancestorsOf(p), ...(kind === 'folder' ? [p] : [])];
    untrack(() => {
      if (need.some((x) => !expanded.has(x))) expanded = new Set([...expanded, ...need]);
    });
  });
  const flip = (set: ReadonlySet<string>, x: string) =>
    new Set(set.has(x) ? [...set].filter((y) => y !== x) : [...set, x]);
  function toggle(p: string) {
    expanded = flip(expanded, p);
  }
  const tree = $derived(buildTree(nodes));

  // ── selection (⌘/Ctrl-click) ───────────────────────────────────────────────
  let selected = $state<Set<string>>(new Set());
  function select(n: Node) {
    selected = flip(selected, n.id);
  }

  function open(n: Node) {
    selected = new Set();
    go(n.path);
  }

  // ── dialogs ────────────────────────────────────────────────────────────────
  type Naming = { kind: 'file' | 'folder'; folder: string } | { kind: 'rename'; node: Node } | null;
  let naming = $state<Naming>(null);
  let namingOpen = $state(false);
  let moving = $state<Node | null>(null);
  let movingOpen = $state(false);
  let deleting = $state<Node[]>([]);
  let deletingOpen = $state(false);
  let deleteBusy = $state(false);

  function askName(n: Exclude<Naming, null>) {
    naming = n;
    namingOpen = true;
  }
  const namingFolder = $derived(
    naming ? (naming.kind === 'rename' ? memoryParentPath(naming.node.path) : naming.folder) : '',
  );

  /** `p` is the full path the dialog resolved (a typed '/' makes folders). */
  async function submitName(p: string): Promise<boolean> {
    const n = naming;
    if (!n) return false;
    if (n.kind === 'rename') {
      const to = await moveNode(memoryId, n.node, p);
      if (to && (path === n.node.path || path.startsWith(n.node.path + '/')))
        go(to + path.slice(n.node.path.length));
      return !!to;
    }
    if (n.kind === 'folder') {
      const ok = await createFolder(memoryId, p);
      if (ok) go(p);
      return ok;
    }
    const ok = await createFile(memoryId, p);
    if (ok) go(p, { mode: 'code' });
    return ok;
  }

  async function submitMove(target: string): Promise<boolean> {
    const n = moving;
    if (!n) return false;
    const to = await moveNode(memoryId, n, movedPath(n, target));
    if (to && (path === n.path || path.startsWith(n.path + '/')))
      go(to + path.slice(n.path.length));
    return !!to;
  }

  function askDelete(list: Node[]) {
    deleting = list;
    deletingOpen = true;
  }
  const deleteStats = $derived(
    deleting.reduce(
      (acc, n) => {
        const s = subtreeStats(nodes, n.path);
        return { files: acc.files + s.files, bytes: acc.bytes + s.bytes };
      },
      { files: 0, bytes: 0 },
    ),
  );
  async function confirmDelete() {
    deleteBusy = true;
    try {
      const n = await deleteNodes(
        memoryId,
        deleting.map((d) => d.id),
      );
      if (n) {
        toast.success(n === 1 ? 'Deleted' : `Deleted ${n} items`);
        if (deleting.some((d) => path === d.path || path.startsWith(d.path + '/')))
          go(memoryParentPath(deleting[0]!.path));
        selected = new Set();
        deletingOpen = false;
      }
    } finally {
      deleteBusy = false;
    }
  }

  // ── uploads ────────────────────────────────────────────────────────────────
  let fileInput: HTMLInputElement | undefined = $state();
  let dirInput: HTMLInputElement | undefined = $state();
  let uploadInto = $state('');
  // Picked files first say where they go (UploadDialog); drops go straight in.
  let picked = $state<{ file: File; relative: string }[]>([]);
  let pickedFolder = $state(false);
  let uploadOpen = $state(false);
  function pickFiles(into: string, dir = false) {
    uploadInto = into;
    (dir ? dirInput : fileInput)?.click();
  }
  function askWhere(list: { file: File; relative: string }[], dir: boolean) {
    if (!writable || !list.length) return;
    picked = list;
    pickedFolder = dir;
    uploadOpen = true;
  }
  async function uploadTo(list: { file: File; path: string }[]) {
    const done = await Promise.all(list.map((f) => memoryUploads.add(memoryId, f.path, f.file)));
    if (list.length === 1 && done[0] && view === 'tree') go(list[0]!.path);
  }
  async function uploadList(into: string, list: { file: File; relative: string }[]) {
    if (!writable || !list.length) return;
    let bad = 0;
    const jobs: Promise<boolean>[] = [];
    for (const { file, relative } of list) {
      const p = uploadTarget(into, relative);
      if (!p) {
        bad++;
        continue;
      }
      jobs.push(memoryUploads.add(memoryId, p, file));
    }
    if (bad)
      toast.error(`${bad} ${bad === 1 ? 'file has' : 'files have'} a name that cannot be used`);
    const done = (await Promise.all(jobs)).filter(Boolean).length;
    if (done && list.length === 1 && view === 'tree') {
      const p = uploadTarget(into, list[0]!.relative);
      if (p) go(p);
    }
  }
  async function dropFiles(into: string, dt: DataTransfer) {
    await uploadList(into, await filesFromDrop(dt));
  }
  async function dropNode(nodeId: string, target: string) {
    const n = nodes.find((x) => x.id === nodeId);
    if (!n || memoryParentPath(n.path) === target) return;
    if (n.kind === 'folder' && (target === n.path || target.startsWith(n.path + '/'))) return;
    const dest = movedPath(n, target);
    if (findByPath(nodes, dest)) {
      toast.error(`${n.name} is already in ${target || 'the top level'}`);
      return;
    }
    const to = await moveNode(memoryId, n, dest);
    if (to) {
      toast.success(`Moved to ${target || 'the top level'}`);
      if (path === n.path || path.startsWith(n.path + '/')) go(to + path.slice(n.path.length));
    }
  }
  function dropOn(e: DragEvent, target: string) {
    const got = memoryDrag.take(e, target, writable);
    if (!got) return;
    if ('nodeId' in got) void dropNode(got.nodeId, target);
    else void dropFiles(target, got.files);
  }
  const dragLabel = $derived.by(() => {
    const t = memoryDrag.over;
    if (t === null) return null;
    const where = t ? `/${t}` : 'the top level';
    return memoryDrag.node ? `Move ${memoryDrag.node.name} into ${where}` : `Upload into ${where}`;
  });

  // The page fills the window under the app's own top bar (as an artifact does).
  let pageEl: HTMLDivElement | undefined = $state();
  let top = $state(0);
  function measure() {
    if (pageEl) top = Math.max(0, Math.round(pageEl.getBoundingClientRect().top + window.scrollY));
  }
  $effect(() => {
    if (!pageEl) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    return () => ro.disconnect();
  });

  // ── menus ──────────────────────────────────────────────────────────────────
  /** New / upload in `f` — the Add menu, a folder's menu and the empty space's. */
  function addIn(f: string, first = false): MenuItem[] {
    if (!writable) return [];
    return [
      {
        label: 'New file',
        icon: FilePlus,
        separator: !first,
        onSelect: () => askName({ kind: 'file', folder: f }),
      },
      {
        label: 'New folder',
        icon: FolderPlus,
        onSelect: () => askName({ kind: 'folder', folder: f }),
      },
      { label: 'Upload files…', icon: Upload, separator: true, onSelect: () => pickFiles(f) },
      { label: 'Upload a folder…', icon: FolderUp, onSelect: () => pickFiles(f, true) },
    ];
  }

  function itemsFor(n: Node): MenuItem[] {
    const isFolder = n.kind === 'folder';
    const items: MenuItem[] = [{ label: 'Open', icon: Eye, onSelect: () => open(n) }];
    if (!isFolder)
      items.push({
        label: 'Open as code',
        icon: Code2,
        onSelect: () => go(n.path, { mode: 'code' }),
      });
    // A folder adds inside itself; a file, beside itself.
    items.push(...addIn(isFolder ? n.path : memoryParentPath(n.path)));
    if (writable)
      items.push(
        {
          label: 'Rename',
          icon: Pencil,
          kbd: 'F2',
          separator: true,
          onSelect: () => askName({ kind: 'rename', node: n }),
        },
        {
          label: 'Move to…',
          icon: FolderInput,
          onSelect: () => ((moving = n), (movingOpen = true)),
        },
      );
    items.push({
      label: 'Copy path',
      icon: Copy,
      separator: !writable,
      onSelect: () => copyPath(n.path),
    });
    if (!isFolder && n.file)
      items.push({
        label: 'Download',
        icon: Download,
        onSelect: () =>
          n.file && downloadFile({ path: n.file.storagePath, name: n.name, size: n.file.size }),
      });
    if (writable)
      items.push({
        label: isFolder ? 'Delete folder' : 'Delete file',
        icon: Trash2,
        danger: true,
        separator: true,
        onSelect: () => askDelete([n]),
      });
    return items;
  }

  const addItems = $derived<MenuItem[]>(addIn(folder, true));

  // ── right-click and keys ───────────────────────────────────────────────────
  let ctx: ContextMenu | undefined = $state();
  /** A node's menu, or (null) the menu of the place: `area` ('' = the top level). */
  function context(e: MouseEvent, n: Node | null, area: string) {
    const items = n ? itemsFor(n) : addIn(area, true);
    if (!n && items.length)
      items.push({
        label: 'Copy path',
        icon: Copy,
        separator: true,
        onSelect: () => copyPath(area || '/'),
      });
    void ctx?.show(e, items);
  }
  function key(e: KeyboardEvent, n: Node) {
    if (!writable) return;
    if (e.key === 'F2') {
      e.preventDefault();
      askName({ kind: 'rename', node: n });
    } else if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      askDelete(selected.has(n.id) ? selectedNodes : [n]);
    }
  }

  const countOf = (f: Node) => subtreeStats(nodes, f.path).files;
  const folderChildren = $derived(childrenOf(nodes, folder));
  const selectedNodes = $derived(nodes.filter((n) => selected.has(n.id)));
</script>

<svelte:window onresize={measure} />
<svelte:head><title>{mem?.name ?? 'Memory'} · TaskManager</title></svelte:head>

{#if $docQ.error || (!$docQ.loading && !mem)}
  <EmptyState
    icon={SearchX}
    title="Memory not found"
    description="It may have been deleted, or it isn't shared with you."
  >
    {#snippet action()}<Button href={routes.memories()}>All memory</Button>{/snippet}
  </EmptyState>
{:else if !mem}
  <div class="flex flex-col gap-3 p-6">
    <Skeleton height="1.5rem" width="16rem" /><Skeleton lines={5} />
  </div>
{:else}
  <div
    bind:this={pageEl}
    style:height="calc(100dvh - {top}px)"
    class="flex min-h-0 flex-col bg-bg"
    data-memory-page={memoryId}
    data-view={view}
    ondragover={(e) => memoryDrag.hover(e, folder, writable)}
    ondragleave={(e) => memoryDrag.leave(e)}
    ondrop={(e) => dropOn(e, folder)}
    role="none"
  >
    <header class="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
      {#if $switchQ.workspace}<WorkspaceCrumb workspace={$switchQ.workspace} />{/if}
      <TitleSwitcher
        kind="memory"
        items={$switchQ.items}
        name={mem.name}
        mark={{ of: mem, seed: memoryId, fallback: MEMORY_DEFAULT_INDICATOR }}
      />
      {#if mem.archivedAt != null}
        <span class="shrink-0 rounded bg-warning-soft px-1.5 py-0.5 text-xs text-warning"
          >Archived</span
        >
      {:else if !writable}
        <span class="flex shrink-0 items-center gap-1 text-xs text-subtle"
          ><Lock size={12} aria-hidden="true" /> Read only</span
        >
      {/if}
      <span class="hidden shrink-0 text-xs text-subtle md:inline"
        >{mem.stats.files}
        {mem.stats.files === 1 ? 'file' : 'files'} · {formatBytes(mem.stats.bytes)}</span
      >
      <span class="flex-1"></span>
      {#if selectedNodes.length && writable}
        <Button size="sm" variant="danger" icon={Trash2} onclick={() => askDelete(selectedNodes)}
          >Delete {selectedNodes.length}</Button
        >
        <Button size="sm" variant="ghost" onclick={() => (selected = new Set())}>Clear</Button>
      {/if}
      <div class="flex rounded-md border border-line p-0.5" role="group" aria-label="View">
        <button
          type="button"
          aria-pressed={view === 'tree'}
          title="Tree"
          class="flex items-center gap-1 rounded px-2 py-0.5 text-xs {view === 'tree'
            ? 'bg-surface-3 font-medium text-text'
            : 'text-muted hover:text-text'}"
          onclick={() => setView('tree')}
          ><FolderTree size={13} aria-hidden="true" /><span class="hidden sm:inline">Tree</span
          ></button
        >
        <button
          type="button"
          aria-pressed={view === 'folders'}
          title="Folders"
          class="flex items-center gap-1 rounded px-2 py-0.5 text-xs {view === 'folders'
            ? 'bg-surface-3 font-medium text-text'
            : 'text-muted hover:text-text'}"
          onclick={() => setView('folders')}
          ><LayoutGrid size={13} aria-hidden="true" /><span class="hidden sm:inline">Folders</span
          ></button
        >
      </div>
      {#if writable}
        <Menu items={addItems} placement="bottom-end">
          {#snippet trigger(p)}
            <Button {...p} size="sm" variant="primary" icon={Plus}
              ><span class="hidden sm:inline">Add</span></Button
            >
          {/snippet}
        </Menu>
      {/if}
      {#if canManage(reach)}
        <IconButton icon={Share2} label="Share" href={routes.memorySettings(memoryId, 'people')} />
      {/if}
      {#if role}
        <IconButton
          icon={Settings}
          label="Memory settings"
          href={routes.memorySettings(memoryId, role === 'owner' ? 'general' : 'subscribers')}
        />
      {/if}
    </header>

    {#snippet breadcrumb()}
      <nav
        class="flex min-w-0 items-center gap-1 overflow-x-auto px-3 py-2 text-sm whitespace-nowrap"
        aria-label="Folder"
        data-breadcrumb
      >
        <button
          type="button"
          class="flex items-center gap-1 rounded px-1 {memoryDrag.over === ''
            ? 'bg-accent-soft text-text ring-1 ring-accent'
            : 'text-muted hover:text-text'}"
          ondragover={(e) => memoryDrag.hover(e, '', writable)}
          ondrop={(e) => dropOn(e, '')}
          oncontextmenu={(e) => context(e, null, '')}
          onclick={() => go('')}><Home size={14} aria-hidden="true" /> {mem.name}</button
        >
        {#each crumbs(openNode?.path ?? '') as c (c.path)}
          <ChevronRight size={13} class="shrink-0 text-subtle" aria-hidden="true" />
          {@const crumbNode = findByPath(nodes, c.path)}
          <button
            type="button"
            class="rounded px-1 {memoryDrag.over === c.path
              ? 'bg-accent-soft text-text ring-1 ring-accent'
              : c.path === openNode?.path
                ? 'font-medium text-text'
                : 'text-muted hover:text-text'}"
            ondragover={(e) =>
              crumbNode?.kind === 'folder'
                ? memoryDrag.hover(e, c.path, writable)
                : memoryDrag.hover(e, memoryParentPath(c.path), writable)}
            ondrop={(e) =>
              dropOn(e, crumbNode?.kind === 'folder' ? c.path : memoryParentPath(c.path))}
            oncontextmenu={(e) => crumbNode && context(e, crumbNode, c.path)}
            onclick={() => go(c.path)}>{c.name}</button
          >
        {/each}
      </nav>
    {/snippet}

    {#if $nodesQ.loading}
      <div class="flex flex-col gap-2 p-6"><Skeleton lines={6} /></div>
    {:else if missing}
      <EmptyState
        icon={SearchX}
        title="Not in this memory"
        description="It may have been moved, renamed or deleted."
      >
        {#snippet action()}<Button onclick={() => go('')}>Back to the top</Button>{/snippet}
      </EmptyState>
    {:else if !nodes.length}
      <EmptyState
        icon={Upload}
        title="Nothing here yet"
        description={writable
          ? 'Drop files or whole folders anywhere on this page, or use Add.'
          : 'Nobody has put anything in this memory yet.'}
      >
        {#snippet action()}
          {#if writable}<Button variant="primary" icon={Upload} onclick={() => pickFiles('')}
              >Upload files</Button
            >{/if}
        {/snippet}
      </EmptyState>
    {:else if view === 'tree'}
      <div class="flex min-h-0 flex-1">
        <aside
          class="flex min-h-0 w-full shrink-0 flex-col overflow-y-auto border-r border-line bg-surface p-2 md:w-72
            {openFile ? 'hidden md:flex' : 'flex'}"
          aria-label="Files"
        >
          <TreeView
            {tree}
            {expanded}
            current={openNode?.path ?? null}
            {selected}
            {writable}
            {itemsFor}
            oncontext={(e, n) => context(e, n, '')}
            onkey={key}
            onopen={open}
            ontoggle={toggle}
            onselect={select}
            ondropfiles={(f, dt) => void dropFiles(f, dt)}
            ondropnode={(id, f) => void dropNode(id, f)}
          />
        </aside>
        <main class="min-h-0 min-w-0 flex-1 {openFile ? 'flex' : 'hidden md:flex'} flex-col">
          {#if openFile}
            <div class="flex items-center border-b border-line md:hidden">
              <button
                type="button"
                class="flex items-center gap-1 px-3 py-2 text-sm text-muted"
                onclick={() => go(memoryParentPath(openFile.path))}
                ><ArrowLeft size={14} aria-hidden="true" /> Files</button
              >
            </div>
            {#key openFile.id}
              <FilePane
                {memoryId}
                node={openFile}
                {writable}
                bind:mode
                bind:dirty
                onrename={() => askName({ kind: 'rename', node: openFile })}
              />
            {/key}
          {:else}
            {@render breadcrumb()}
            <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
              <FolderView
                {folder}
                children={folderChildren}
                {countOf}
                peek={(f) => childrenOf(nodes, f.path).slice(0, 4)}
                {selected}
                {writable}
                {itemsFor}
                oncontext={(e, n) => context(e, n, folder)}
                onkey={key}
                onopen={open}
                onselect={select}
                ondropfiles={(f, dt) => void dropFiles(f, dt)}
                ondropnode={(id, f) => void dropNode(id, f)}
              />
            </div>
          {/if}
        </main>
      </div>
    {:else}
      <div class="flex min-h-0 flex-1 flex-col">
        <div class="border-b border-line bg-surface">{@render breadcrumb()}</div>
        {#if openFile}
          <div class="min-h-0 flex-1">
            {#key openFile.id}
              <FilePane
                {memoryId}
                node={openFile}
                {writable}
                bind:mode
                bind:dirty
                onrename={() => askName({ kind: 'rename', node: openFile })}
              />
            {/key}
          </div>
        {:else}
          <div class="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
            <FolderView
              {folder}
              children={folderChildren}
              {countOf}
              peek={(f) => childrenOf(nodes, f.path).slice(0, 4)}
              {selected}
              {writable}
              {itemsFor}
              oncontext={(e, n) => context(e, n, folder)}
              onkey={key}
              onopen={open}
              onselect={select}
              ondropfiles={(f, dt) => void dropFiles(f, dt)}
              ondropnode={(id, f) => void dropNode(id, f)}
            />
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <input
    bind:this={fileInput}
    type="file"
    multiple
    class="hidden"
    data-upload-input
    onchange={(e) => {
      const el = e.currentTarget as HTMLInputElement;
      askWhere(filesFromInput(el.files), false);
      el.value = '';
    }}
  />
  <input
    bind:this={dirInput}
    type="file"
    webkitdirectory
    multiple
    class="hidden"
    data-upload-folder-input
    onchange={(e) => {
      const el = e.currentTarget as HTMLInputElement;
      askWhere(filesFromInput(el.files), true);
      el.value = '';
    }}
  />

  <NameDialog
    bind:open={namingOpen}
    title={naming?.kind === 'rename'
      ? `Rename ${naming.node.name}`
      : naming?.kind === 'folder'
        ? 'New folder'
        : 'New file'}
    action={naming?.kind === 'rename' ? 'Rename' : 'Create'}
    initial={naming?.kind === 'rename'
      ? naming.node.name
      : naming?.kind === 'folder'
        ? freeName(nodes, namingFolder, 'New folder')
        : freeName(nodes, namingFolder, 'untitled.md')}
    folder={namingFolder}
    {nodes}
    node={naming?.kind === 'rename' ? naming.node : null}
    onsubmit={submitName}
  />
  <UploadDialog
    bind:open={uploadOpen}
    folder={uploadInto}
    {picked}
    asFolder={pickedFolder}
    {nodes}
    onsubmit={(list) => void uploadTo(list)}
  />
  <ContextMenu bind:this={ctx} />
  {#if dragLabel}
    <div
      class="pointer-events-none fixed z-[70] max-w-80 truncate rounded-md bg-accent px-2 py-1 text-xs font-medium text-white shadow-pop"
      style:left="{memoryDrag.x + 14}px"
      style:top="{memoryDrag.y + 16}px"
      data-drag-label
    >
      {dragLabel}
    </div>
  {/if}
  <MoveDialog bind:open={movingOpen} node={moving} {nodes} onsubmit={submitMove} />
  <Dialog
    bind:open={deletingOpen}
    title={deleting.length === 1
      ? `Delete ${deleting[0]?.name}?`
      : `Delete ${deleting.length} items?`}
    size="sm"
  >
    <p class="text-sm text-muted">
      {#if deleteStats.files}
        {deleteStats.files}
        {deleteStats.files === 1 ? 'file' : 'files'} ({formatBytes(deleteStats.bytes)}) will be gone
        for good.
      {:else}This cannot be undone.{/if}
      Tickets that point at them will show them as no longer in memory.
    </p>
    {#snippet footer()}
      <Button variant="ghost" onclick={() => (deletingOpen = false)}>Cancel</Button>
      <Button variant="danger" loading={deleteBusy} onclick={confirmDelete}>Delete</Button>
    {/snippet}
  </Dialog>
  <UploadTray {memoryId} />
{/if}

<!--
  WHERE DO THESE GO (memory.html §F): picked files are not uploaded blind.
  Each file gets ONE field — its full path in the memory, folder and name
  together ("/docs/brand/logo.svg"), filled in with the folder you are in. Edit
  it to rename the file or send it elsewhere; missing folders are created. A
  picked folder gets one field instead: the folder it becomes.

  A path where a file already is replaces that file (a new version, as Replace…
  does); a path where a folder is, or under a file, is refused.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { FolderUp, X } from 'lucide-svelte';
  import { formatBytes } from '@tm/shared';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';
  import { KIND_ICON, kindOf } from '$lib/files/kinds';
  import {
    crumbs,
    findByPath,
    joinMemoryPath,
    memoryParentPath,
    resolveTypedPath,
    typedPathProblem,
    uploadTarget,
    type Node,
  } from './tree';

  interface Picked {
    file: File;
    /** Its path inside a picked folder ('' segments for a plain file = its name). */
    relative: string;
  }
  interface Props {
    open: boolean;
    /** The folder they go into unless changed ('' = the top level). */
    folder: string;
    picked: Picked[];
    /** A folder was picked (webkitdirectory): one destination for all of it. */
    asFolder: boolean;
    nodes: readonly Node[];
    onsubmit: (list: { file: File; path: string }[]) => void;
  }
  let { open = $bindable(false), folder, picked, asFolder, nodes, onsubmit }: Props = $props();

  const show = (p: string) => '/' + p;

  // ── one field per file ─────────────────────────────────────────────────────
  let rows = $state<{ file: File; value: string }[]>([]);
  // ── or one for the folder ─────────────────────────────────────────────────
  let dest = $state('');
  /** The picked folder's own name: files keep their path below it. */
  const top = $derived(asFolder ? (picked[0]?.relative.split('/')[0] ?? '') : '');
  let touched = $state(false);
  let first: HTMLInputElement | null = $state(null);

  // Filled in once per opening (not again when the memory changes underneath).
  $effect(() => {
    if (open) untrack(fill);
  });
  function fill() {
    touched = false;
    if (asFolder) dest = show(joinMemoryPath(folder, top));
    else
      rows = picked.map(({ file, relative }) => ({
        file,
        value: show(uploadTarget(folder, relative) ?? joinMemoryPath(folder, file.name)),
      }));
    // One file: select its name (not the folder, not the extension) to retype it.
    queueMicrotask(() => {
      if (!first) return;
      first.focus();
      const v = first.value;
      const slash = v.lastIndexOf('/') + 1;
      const dot = v.lastIndexOf('.');
      first.setSelectionRange(slash, dot > slash ? dot : v.length);
    });
  }

  /** Why a file cannot be written at `p`, or null. */
  function spotProblem(p: string): string | null {
    const there = findByPath(nodes, p);
    if (there?.kind === 'folder') return 'A folder is already at that path';
    for (const a of crumbs(memoryParentPath(p)))
      if (findByPath(nodes, a.path)?.kind === 'file') return `/${a.path} is a file, not a folder`;
    return null;
  }

  const checked = $derived(
    rows.map((r, i) => {
      const path = resolveTypedPath(r.value, '');
      const problem =
        typedPathProblem(r.value, '') ??
        (path && rows.some((o, j) => j < i && resolveTypedPath(o.value, '') === path)
          ? 'Two files would get the same path'
          : null) ??
        (path ? spotProblem(path) : null);
      const replaces = !problem && !!path && findByPath(nodes, path)?.kind === 'file';
      return { path, problem, replaces };
    }),
  );

  const destPath = $derived(asFolder ? resolveTypedPath(dest, '') : null);
  const folderFiles = $derived(
    asFolder && destPath
      ? picked.map(({ file, relative }) => ({
          file,
          path: uploadTarget(destPath, relative.split('/').slice(1).join('/')),
        }))
      : [],
  );
  const destProblem = $derived.by(() => {
    if (!asFolder) return null;
    const p = typedPathProblem(dest, '');
    if (p || !destPath) return p ?? "That path can't be used";
    if (findByPath(nodes, destPath)?.kind === 'file') return 'A file is already at that path';
    for (const a of crumbs(memoryParentPath(destPath)))
      if (findByPath(nodes, a.path)?.kind === 'file') return `/${a.path} is a file, not a folder`;
    if (folderFiles.some((f) => !f.path)) return 'Some paths inside it would be too long';
    return null;
  });
  const replacing = $derived(
    folderFiles.filter((f) => f.path && findByPath(nodes, f.path)?.kind === 'file').length,
  );
  const totalBytes = $derived(picked.reduce((n, p) => n + p.file.size, 0));

  const blocked = $derived(
    asFolder ? !!destProblem : !rows.length || checked.some((c) => c.problem),
  );

  function submit() {
    touched = true;
    if (blocked) return;
    const list = asFolder
      ? folderFiles.map((f) => ({ file: f.file, path: f.path! }))
      : rows.map((r, i) => ({ file: r.file, path: checked[i]!.path! }));
    open = false;
    onsubmit(list);
  }
</script>

<Dialog
  bind:open
  title={asFolder
    ? `Upload ${top || 'a folder'}`
    : picked.length === 1
      ? 'Upload a file'
      : `Upload ${picked.length} files`}
  size="md"
  description={asFolder
    ? `${picked.length} ${picked.length === 1 ? 'file' : 'files'} · ${formatBytes(totalBytes)}. Where should the folder go?`
    : 'Edit a path to rename the file or put it somewhere else; folders are created.'}
>
  <form id="memory-upload" onsubmit={(e) => (e.preventDefault(), submit())} data-upload-dialog>
    {#if asFolder}
      <div class="flex items-start gap-2">
        <FolderUp size={16} class="mt-2 shrink-0 text-accent" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <Input
            label="Folder path"
            bind:value={dest}
            bind:ref={first}
            maxlength={1024}
            autocomplete="off"
            spellcheck={false}
            data-upload-path
            error={touched || dest ? (destProblem ?? undefined) : undefined}
            oninput={() => (touched = true)}
          />
          {#if replacing && !destProblem}
            <p class="mt-1 text-xs text-warning">
              {replacing}
              {replacing === 1 ? 'file is' : 'files are'} already there and will be replaced.
            </p>
          {/if}
        </div>
      </div>
    {:else}
      <ul class="flex max-h-[55vh] flex-col gap-3 overflow-y-auto pr-1">
        {#each rows as r, i (r.file)}
          {@const Icon = KIND_ICON[kindOf({ name: r.file.name, mime: r.file.type })]}
          {@const c = checked[i]}
          <li class="flex items-start gap-2" data-upload-row>
            <Icon size={16} class="mt-2 shrink-0 text-muted" aria-hidden="true" />
            <div class="min-w-0 flex-1">
              {#if i === 0}
                <Input
                  label={rows.length === 1 ? 'Path' : undefined}
                  aria-label="Path for {r.file.name}"
                  bind:value={r.value}
                  bind:ref={first}
                  maxlength={1024}
                  autocomplete="off"
                  spellcheck={false}
                  data-upload-path
                  error={c?.problem ?? undefined}
                  oninput={() => (touched = true)}
                />
              {:else}
                <Input
                  aria-label="Path for {r.file.name}"
                  bind:value={r.value}
                  maxlength={1024}
                  autocomplete="off"
                  spellcheck={false}
                  data-upload-path
                  error={c?.problem ?? undefined}
                  oninput={() => (touched = true)}
                />
              {/if}
              <p class="mt-1 text-xs text-subtle">
                {r.file.name} · {formatBytes(r.file.size)}{#if c?.replaces}
                  · <span class="text-warning">replaces the file already there</span>{/if}
              </p>
            </div>
            {#if rows.length > 1}
              <button
                type="button"
                class="mt-1.5 grid size-7 shrink-0 place-items-center rounded text-subtle hover:bg-surface-2 hover:text-text"
                aria-label="Don't upload {r.file.name}"
                onclick={() => (rows = rows.filter((_, j) => j !== i))}><X size={14} /></button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" type="submit" form="memory-upload" disabled={blocked}
      >Upload{asFolder || rows.length <= 1 ? '' : ` ${rows.length}`}</Button
    >
  {/snippet}
</Dialog>

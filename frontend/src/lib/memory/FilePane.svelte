<!--
  One memory file (docs/plan/memory.html §F): PREVIEW — the same viewer body as
  ticket files (FileContent: Markdown rendered, images, video, audio, PDF,
  highlighted text, and facts + Download for anything else) — or CODE: the
  file as text in an editor, saved as a new version (memoryFileWrite with
  expectedFileId, so a save never silently overwrites someone else's). A
  binary file in Code mode shows its facts and Replace… instead of bytes.
-->
<script lang="ts">
  import { Download, Eye, Code2, Save, Upload, Loader2, FileWarning } from 'lucide-svelte';
  import {
    MEMORY_INLINE_MAX_BYTES,
    formatBytes,
    isMemoryTextFile,
    memoryPreviewKind,
  } from '@tm/shared';
  import { command, isAppError } from '$lib/api';
  import { relativeTime } from '$lib/account/format';
  import { downloadFile, fileText } from '$lib/files/source';
  import FileContent from '$lib/files/FileContent.svelte';
  import MarkdownDoc from '$lib/files/MarkdownDoc.svelte';
  import type { ViewerFile } from '$lib/files/types';
  import { Button, toast } from '$lib/ui';
  import CodeEditor from './CodeEditor.svelte';
  import type { FileMode } from './store';
  import type { Node } from './tree';
  import { memoryUploads } from './upload.svelte';

  interface Props {
    memoryId: string;
    node: Node;
    writable: boolean;
    mode: FileMode;
    /** Unsaved edits in Code mode — the page guards navigation with it. */
    dirty?: boolean;
  }
  let { memoryId, node, writable, mode = $bindable(), dirty = $bindable(false) }: Props = $props();

  const file = $derived(node.file);
  const viewerFile = $derived<ViewerFile | null>(
    file
      ? {
          id: node.id,
          path: file.storagePath,
          name: node.name,
          mime: file.mime,
          size: file.size,
          width: file.width,
          height: file.height,
          createdAt: node.updatedAt,
        }
      : null,
  );
  const textual = $derived(!!file && isMemoryTextFile(node.name, file.mime));
  const tooBig = $derived(!!file && file.size > MEMORY_INLINE_MAX_BYTES);
  const kind = $derived(file ? memoryPreviewKind(node.name, file.mime) : 'other');

  // ── Code mode ────────────────────────────────────────────────────────────────
  /** The version the editor was loaded from: a save names it (expectedFileId). */
  let base = $state<{ fileId: string; text: string } | null>(null);
  let draft = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let saving = $state(false);
  /** Someone saved a newer version while I was editing. */
  let conflict = $state(false);

  $effect(() => {
    dirty = draft !== null && base !== null && draft !== base.text;
  });

  // Load (or reload) the text when Code mode opens a file, or a NEW version
  // lands and there is nothing unsaved to lose.
  $effect(() => {
    const f = file;
    const vf = viewerFile;
    if (mode !== 'code' || !f || !vf || !textual || tooBig) return;
    if (base?.fileId === f.fileId) return;
    if (base && draft !== null && draft !== base.text) {
      conflict = true;
      return;
    }
    let alive = true;
    loadError = null;
    fileText(vf, MEMORY_INLINE_MAX_BYTES)
      .then((r) => {
        if (!alive) return;
        base = { fileId: f.fileId, text: r.text };
        draft = null;
        conflict = false;
      })
      .catch(() => alive && (loadError = 'Could not load this file.'));
    return () => {
      alive = false;
    };
  });

  // (The parent keys this component by node id: a different file starts fresh.)

  async function save(force = false) {
    if (!writable || saving || !base || draft === null) return;
    saving = true;
    const text = draft;
    try {
      const r = await command(
        'memoryFileWrite',
        {
          memoryId,
          nodeId: node.id,
          text,
          ...(file?.mime ? { mime: file.mime } : {}),
          expectedFileId: force ? null : base.fileId,
        },
        { toast: false },
      );
      base = { fileId: r.fileId, text };
      draft = null;
      conflict = false;
      toast.success('Saved');
    } catch (e) {
      if (isAppError(e) && e.code === 'conflict') conflict = true;
      else toast.error('Could not save', isAppError(e) ? e.message : undefined);
    } finally {
      saving = false;
    }
  }

  /** Take their version: drop my edits and load the current one. */
  function loadTheirs() {
    base = null;
    draft = null;
    conflict = false;
  }

  // ── Replace… (any file, binary or not) ───────────────────────────────────────
  let picker: HTMLInputElement | undefined = $state();
  async function replace(list: FileList | null) {
    const f = list?.[0];
    if (!f || !file) return;
    const ok = await memoryUploads.add(memoryId, node.path, f, { expectedFileId: file.fileId });
    if (ok) toast.success(`Replaced ${node.name}`);
    if (picker) picker.value = '';
  }
</script>

<div class="flex size-full min-h-0 flex-col" data-memory-file={node.path}>
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
    <span class="min-w-0 flex-1 truncate text-sm font-medium" title={node.path}>{node.name}</span>
    {#if dirty}<span class="text-xs text-warning" data-dirty>Unsaved</span>{/if}
    {#if file}
      <span class="hidden text-xs text-subtle sm:inline"
        >{formatBytes(file.size)} · {relativeTime(node.updatedAt)}</span
      >
    {/if}
    <div class="flex rounded-md border border-line p-0.5" role="tablist" aria-label="File mode">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'preview'}
        class="flex items-center gap-1 rounded px-2 py-0.5 text-xs {mode === 'preview'
          ? 'bg-surface-3 font-medium text-text'
          : 'text-muted hover:text-text'}"
        onclick={() => (mode = 'preview')}><Eye size={13} aria-hidden="true" /> Preview</button
      >
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'code'}
        class="flex items-center gap-1 rounded px-2 py-0.5 text-xs {mode === 'code'
          ? 'bg-surface-3 font-medium text-text'
          : 'text-muted hover:text-text'}"
        onclick={() => (mode = 'code')}><Code2 size={13} aria-hidden="true" /> Code</button
      >
    </div>
    {#if mode === 'code' && writable && textual && !tooBig}
      <Button
        size="sm"
        variant="primary"
        icon={Save}
        loading={saving}
        disabled={!dirty}
        onclick={() => save()}>Save</Button
      >
    {/if}
    {#if writable && file}
      <button
        type="button"
        class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2 hover:text-text"
        aria-label="Replace {node.name}"
        title="Replace with another file…"
        onclick={() => picker?.click()}><Upload size={15} aria-hidden="true" /></button
      >
      <input
        bind:this={picker}
        type="file"
        class="hidden"
        data-replace-input
        onchange={(e) => replace((e.currentTarget as HTMLInputElement).files)}
      />
    {/if}
    {#if viewerFile}
      <button
        type="button"
        class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2 hover:text-text"
        aria-label="Download {node.name}"
        title="Download"
        onclick={() => viewerFile && downloadFile(viewerFile)}
        ><Download size={15} aria-hidden="true" /></button
      >
    {/if}
  </div>

  {#if conflict}
    <div
      role="alert"
      class="flex flex-wrap items-center gap-2 border-b border-line bg-warning-soft px-3 py-1.5 text-sm"
    >
      <span class="min-w-0 flex-1">Someone saved a newer version of this file.</span>
      <Button size="sm" onclick={loadTheirs}>Load theirs</Button>
      {#if writable}<Button size="sm" variant="danger" onclick={() => save(true)}
          >Overwrite with mine</Button
        >{/if}
    </div>
  {/if}

  <div class="min-h-0 flex-1">
    {#if !file || !viewerFile}
      <p class="p-6 text-sm text-muted">This file has no content yet.</p>
    {:else if mode === 'preview' && kind === 'markdown'}
      <!-- Markdown without the viewer's own Source switch: Code mode is that here. -->
      {#key file.fileId}
        {#await fileText(viewerFile, MEMORY_INLINE_MAX_BYTES)}
          <div class="grid h-full place-items-center text-muted">
            <Loader2 size={20} class="animate-spin" aria-label="Loading" />
          </div>
        {:then r}
          <div class="h-full bg-surface"><MarkdownDoc text={r.text} sourceToggle={false} /></div>
        {:catch}
          <p class="p-6 text-sm text-danger">Could not load this file.</p>
        {/await}
      {/key}
    {:else if mode === 'preview'}
      {#key file.fileId}
        <FileContent file={viewerFile} />
      {/key}
    {:else if textual && !tooBig}
      {#if loadError}
        <p class="p-6 text-sm text-danger">{loadError}</p>
      {:else if !base}
        <div class="grid h-full place-items-center text-muted">
          <Loader2 size={20} class="animate-spin" aria-label="Loading" />
        </div>
      {:else}
        <CodeEditor
          value={base.text}
          name={node.name}
          readOnly={!writable}
          onchange={(t) => (draft = t)}
          onsave={() => save()}
        />
      {/if}
    {:else}
      <div class="grid h-full place-items-center p-6">
        <div class="flex max-w-sm flex-col items-center gap-3 text-center">
          <span class="grid size-16 place-items-center rounded-2xl bg-surface-2 text-muted"
            ><FileWarning size={30} strokeWidth={1.25} /></span
          >
          <p class="text-sm font-medium">{node.name}</p>
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-left text-xs text-muted">
            <dt>Type</dt>
            <dd class="truncate">{file.mime}</dd>
            <dt>Size</dt>
            <dd>{formatBytes(file.size)}</dd>
            <dt>Path</dt>
            <dd class="truncate">{node.path}</dd>
            <dt>Preview</dt>
            <dd>{kind}</dd>
          </dl>
          <p class="text-xs text-subtle">
            {tooBig
              ? `Too large to edit here (over ${formatBytes(MEMORY_INLINE_MAX_BYTES)}).`
              : 'Not a text file, so there is no code to edit.'}
          </p>
          {#if writable}
            <Button size="sm" icon={Upload} onclick={() => picker?.click()}>Replace…</Button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

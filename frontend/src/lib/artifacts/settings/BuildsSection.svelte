<!--
  Artifact settings › Builds (owner and editors; docs/plan/artifacts.html §C3, §F).

    Publish   drop or pick a .zip — or a FOLDER, zipped here in the browser —
              → Storage artifacts/{id}/uploads/{uploadId}.zip
              → artifactPublish { uploadPath, message }   (same command and
                same checks as the SDK / REST / MCP; the new build is current)
    Builds    newest first: message · who · files · size · when · [current]
              Make current (roll back or forward) · Download source

  Every publish is a new build; publishing never touches the artifact's data.
-->
<script lang="ts">
  import { Check, Download, FileArchive, FolderUp, TriangleAlert, Upload } from 'lucide-svelte';
  import { ref, uploadBytesResumable } from 'firebase/storage';
  import { ARTIFACT_BUILDS_KEPT, artifactPrefix, type ArtifactBuild } from '@tm/shared';
  import { relativeTime } from '$lib/account/format';
  import { command } from '$lib/api';
  import Section from '$lib/board/settings/Section.svelte';
  import { formatBytes } from '$lib/editor/upload';
  import { getStorageClient } from '$lib/firebase/client';
  import { Principal } from '$lib/people';
  import type { WithId } from '$lib/stores';
  import Button from '$lib/ui/Button.svelte';
  import Input from '$lib/ui/Input.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import { artifactBuilds, shortBuild } from '../store';
  import { buildEntries, buildProblem, newUploadId, zipFolder, type FolderFile } from '../zip';
  import { useArtifactSettings } from './context.svelte';

  const s = useArtifactSettings();
  const a = $derived(s.artifact);
  const archived = $derived(a.archivedAt != null);
  const buildsQ = $derived(artifactBuilds(a.id));

  // ── publish ────────────────────────────────────────────────────────────────
  type Picked = { label: string; detail: string; zip: () => Promise<Blob> };
  let picked = $state<Picked | null>(null);
  let source = $state<File | null>(null);
  let message = $state('');
  let problem = $state<string | null>(null);
  let stage = $state<'' | 'zipping' | 'uploading' | 'publishing'>('');
  let progress = $state(0);
  let warnings = $state<string[]>([]);
  let over = $state(false);
  let zipInput = $state<HTMLInputElement | null>(null);
  let folderInput = $state<HTMLInputElement | null>(null);

  const isZip = (f: File) => /\.zip$/i.test(f.name) || f.type === 'application/zip';

  function pickZip(file: File) {
    problem = null;
    warnings = [];
    picked = { label: file.name, detail: formatBytes(file.size), zip: async () => file };
  }

  /** A folder, as the list of its files with paths relative to what was picked. */
  function pickFolder(files: { path: string; file: File }[], name: string) {
    warnings = [];
    try {
      // The server's own entry rule and limits, applied before anything is read.
      const entries = buildEntries(files);
      problem = buildProblem(entries.map((f) => ({ path: f.path, size: f.file.size })));
      if (problem) return void (picked = null);
      const bytes = entries.reduce((n, f) => n + f.file.size, 0);
      picked = {
        label: name,
        detail: `${entries.length} ${entries.length === 1 ? 'file' : 'files'} · ${formatBytes(bytes)}`,
        async zip() {
          const read: FolderFile[] = [];
          for (const f of entries)
            read.push({ path: f.path, bytes: new Uint8Array(await f.file.arrayBuffer()) });
          const zip = zipFolder(read);
          // A copy of exactly the zip's bytes (fflate may hand back a view into a larger buffer).
          const buf = zip.buffer.slice(
            zip.byteOffset,
            zip.byteOffset + zip.byteLength,
          ) as ArrayBuffer;
          return new Blob([buf], { type: 'application/zip' });
        },
      };
    } catch (e) {
      picked = null;
      problem = e instanceof Error ? e.message : 'That folder cannot be published.';
    }
  }

  function onZipInput(e: Event & { currentTarget: HTMLInputElement }) {
    const f = e.currentTarget.files?.[0];
    if (f) pickZip(f);
    e.currentTarget.value = '';
  }
  function onFolderInput(e: Event & { currentTarget: HTMLInputElement }) {
    const list = [...(e.currentTarget.files ?? [])];
    e.currentTarget.value = '';
    if (!list.length) return;
    // webkitRelativePath = 'dist/assets/app.js': the picked folder is the first segment.
    const files = list.map((file) => ({ path: file.webkitRelativePath || file.name, file }));
    pickFolder(files, `${files[0]!.path.split('/')[0]}/`);
  }

  /** A dropped directory arrives as a FileSystemEntry tree; walk it. */
  async function walk(entry: FileSystemEntry, out: { path: string; file: File }[]): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej),
      );
      out.push({ path: entry.fullPath.replace(/^\//, ''), file });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries hands out at most 100 at a time; keep asking until it is empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
        reader.readEntries(res, rej),
      );
      if (!batch.length) break;
      for (const child of batch) await walk(child, out);
      // A project folder dropped by mistake: stop reading long before the tab struggles.
      if (out.length > 5000)
        throw new Error(
          'That folder has too many files. Drop the built folder (dist/), not the project.',
        );
    }
  }
  async function onDrop(e: DragEvent) {
    e.preventDefault();
    over = false;
    if (archived || stage) return;
    const items = [...(e.dataTransfer?.items ?? [])];
    const entries = items
      .map((i) => i.webkitGetAsEntry?.())
      .filter((x): x is FileSystemEntry => !!x);
    const dir = entries.find((x) => x.isDirectory);
    try {
      if (dir) {
        const out: { path: string; file: File }[] = [];
        await walk(dir, out);
        return pickFolder(out, `${dir.name}/`);
      }
      const file = e.dataTransfer?.files?.[0];
      if (file && isZip(file)) return pickZip(file);
      problem = 'Drop a .zip of the build, or the built folder itself.';
    } catch (err) {
      picked = null;
      problem = err instanceof Error ? err.message : 'That could not be read.';
    }
  }

  /** One zip → artifacts/{id}/uploads/{uploadId}.zip; resolves with its path. */
  function upload(blob: Blob, share: [from: number, to: number]): Promise<string> {
    const path = artifactPrefix.storageUpload(a.id, newUploadId());
    const task = uploadBytesResumable(ref(getStorageClient(), path), blob, {
      contentType: 'application/zip',
    });
    return new Promise((resolve, reject) => {
      task.on(
        'state_changed',
        (snap) =>
          (progress =
            share[0] + ((share[1] - share[0]) * snap.bytesTransferred) / (snap.totalBytes || 1)),
        reject,
        () => resolve(path),
      );
    });
  }

  async function publish() {
    if (!picked || stage) return;
    problem = null;
    warnings = [];
    progress = 0;
    try {
      stage = 'zipping';
      const zip = await picked.zip();
      stage = 'uploading';
      const uploadPath = await upload(zip, source ? [0, 0.7] : [0, 1]);
      const sourceUploadPath = source ? await upload(source, [0.7, 1]) : undefined;
      stage = 'publishing';
      const res = await command(
        'artifactPublish',
        {
          artifactId: a.id,
          uploadPath,
          ...(sourceUploadPath ? { sourceUploadPath } : {}),
          message: message.trim() || null,
        },
        { toast: false },
      );
      warnings = res.warnings;
      toast.success(
        'Published',
        `${res.files} ${res.files === 1 ? 'file' : 'files'} · ${formatBytes(res.bytes)} — it is the current build now.`,
      );
      picked = null;
      source = null;
      message = '';
    } catch (e) {
      // Shown in place, not as a toast: "no index.html at the root" is something to read and fix.
      problem = e instanceof Error ? e.message : 'The build could not be published.';
    } finally {
      stage = '';
    }
  }

  // ── the list ───────────────────────────────────────────────────────────────
  let working = $state<string | null>(null);
  async function makeCurrent(b: WithId<ArtifactBuild>) {
    working = b.id;
    try {
      await command(
        'artifactSetCurrent',
        { artifactId: a.id, buildId: b.id },
        { toast: 'Could not switch builds' },
      );
      toast.success(`Build ${shortBuild(b.id)} is current`, 'Open tabs are offered a reload.');
    } catch {
      /* toasted */
    } finally {
      working = null;
    }
  }
  async function downloadSource(b: WithId<ArtifactBuild>) {
    working = b.id;
    try {
      const { url } = await command(
        'artifactSourceUrl',
        { artifactId: a.id, buildId: b.id },
        { toast: 'Could not get the source' },
      );
      // A signed, short-lived link: let the browser download it.
      window.location.assign(url);
    } catch {
      /* toasted */
    } finally {
      working = null;
    }
  }
</script>

<Section
  title="Builds"
  description="Every publish is a new build. The artifact shows the current one; the last {ARTIFACT_BUILDS_KEPT} are kept, and any of them can be made current again. Publishing never touches the data."
>
  <div class="flex flex-col gap-6">
    {#if !archived}
      <div
        role="group"
        aria-label="Publish a build"
        class="flex flex-col gap-3 rounded-xl border border-dashed p-5 transition-colors {over
          ? 'border-accent bg-accent-soft'
          : 'border-line-strong bg-surface'}"
        ondragover={(e) => (e.preventDefault(), (over = true))}
        ondragleave={() => (over = false)}
        ondrop={onDrop}
      >
        <div>
          <h3 class="flex items-center gap-1.5 font-medium">
            <Upload size={15} /> Publish a build
          </h3>
          <p class="text-sm text-muted">
            Drop a <b>.zip</b> of the built folder here, or the folder itself — the one with
            <code class="rounded bg-surface-2 px-1 text-xs">index.html</code> at its top (Vite:
            <code class="rounded bg-surface-2 px-1 text-xs">dist/</code>, built with
            <code class="rounded bg-surface-2 px-1 text-xs">base: './'</code>).
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button icon={FileArchive} disabled={!!stage} onclick={() => zipInput?.click()}
            >Choose a .zip</Button
          >
          <Button icon={FolderUp} disabled={!!stage} onclick={() => folderInput?.click()}
            >Choose a folder</Button
          >
          <input
            bind:this={zipInput}
            type="file"
            accept=".zip,application/zip"
            class="hidden"
            onchange={onZipInput}
          />
          <!-- webkitdirectory: every browser that can pick a folder spells it this way. -->
          <input
            bind:this={folderInput}
            type="file"
            webkitdirectory
            multiple
            class="hidden"
            onchange={onFolderInput}
          />
          {#if picked}
            <span class="min-w-0 truncate text-sm" data-picked>
              <span class="font-medium">{picked.label}</span>
              <span class="text-muted"> · {picked.detail}</span>
            </span>
          {/if}
        </div>

        {#if picked}
          <Input
            label="What changed (optional)"
            bind:value={message}
            maxlength={500}
            placeholder="Fix the totals on the weekly chart"
            disabled={!!stage}
          />
          <label class="flex flex-wrap items-center gap-2 text-sm">
            <span class="text-muted"
              >Source .zip (optional — kept beside the build, never served):</span
            >
            <input
              type="file"
              accept=".zip,application/zip"
              class="text-xs text-muted file:mr-2 file:rounded-md file:border file:border-line file:bg-surface file:px-2 file:py-1 file:text-xs file:text-text"
              disabled={!!stage}
              onchange={(e) => (source = e.currentTarget.files?.[0] ?? null)}
            />
          </label>
          <div class="flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={Upload} loading={!!stage} onclick={() => publish()}
              >Publish</Button
            >
            {#if !stage}
              <Button variant="ghost" onclick={() => ((picked = null), (source = null))}
                >Cancel</Button
              >
            {:else}
              <span class="text-sm text-muted" role="status">
                {stage === 'zipping'
                  ? 'Zipping…'
                  : stage === 'uploading'
                    ? `Uploading ${Math.round(progress * 100)}%`
                    : 'Unpacking and checking…'}
              </span>
            {/if}
          </div>
        {/if}

        {#if problem}
          <p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
            {problem}
          </p>
        {/if}
        {#each warnings as w (w)}
          <p
            class="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning"
            role="status"
          >
            <TriangleAlert size={15} class="mt-0.5 shrink-0" aria-hidden="true" />
            <span>Published, with a warning: {w}</span>
          </p>
        {/each}
      </div>
    {/if}

    {#if $buildsQ.loading}
      <Skeleton lines={3} />
    {:else if $buildsQ.error}
      <p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
        Couldn't load the builds.
      </p>
    {:else if !$buildsQ.data.length}
      <p class="text-sm text-muted">Nothing has been published yet.</p>
    {:else}
      <ul class="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
        {#each $buildsQ.data as b (b.id)}
          {@const current = b.id === a.currentBuild}
          <li class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" data-build={b.id}>
            <div class="min-w-0 flex-1 basis-64">
              <p class="flex min-w-0 items-center gap-2">
                <span class="truncate text-sm font-medium {b.message ? '' : 'text-muted'}"
                  >{b.message || 'No message'}</span
                >
                {#if current}
                  <span
                    class="flex shrink-0 items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success"
                    ><Check size={12} aria-hidden="true" /> current</span
                  >
                {/if}
              </p>
              <p class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                <Principal id={b.by} layout="inline" size={16} />
                <span>· {b.files} {b.files === 1 ? 'file' : 'files'}</span>
                <span>· {formatBytes(b.bytes)}</span>
                <span title={new Date(b.createdAt).toLocaleString()}
                  >· {relativeTime(b.createdAt)}</span
                >
                <span class="font-mono text-subtle">· {shortBuild(b.id)}</span>
              </p>
              {#each b.warnings as w (w)}
                <p class="mt-1 flex items-start gap-1.5 text-xs text-warning">
                  <TriangleAlert size={12} class="mt-0.5 shrink-0" aria-hidden="true" />
                  {w}
                </p>
              {/each}
            </div>
            <div class="flex shrink-0 gap-2">
              {#if b.sourcePath}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Download}
                  disabled={working === b.id}
                  onclick={() => downloadSource(b)}>Source</Button
                >
              {/if}
              {#if !current && !archived}
                <Button size="sm" loading={working === b.id} onclick={() => makeCurrent(b)}
                  >Make current</Button
                >
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</Section>

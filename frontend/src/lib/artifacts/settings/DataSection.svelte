<!--
  Artifact settings › Data (owner and editors; docs/plan/artifacts.html §F) —
  a READ-ONLY look at what the artifact has stored under its prefix:

    Firestore   a path box. The client SDK cannot list the collections under
                a document, so you name one: an odd number of segments lists a
                collection (50 at a time), an even number opens a document.
    Realtime    the subtree at a path, fetched only when asked for and drawn
                as a tree whose branches render when opened.
    Files       artifactFileList, with a short-lived link to open one.

  It goes through the SAME fence and the same store functions as the broker
  (./broker › BrokerBackend, @tm/shared artifacts/paths), so what you see here
  is exactly what the artifact's own db.firestore.get / list would return.

  Delete all data (owner): artifactDataClear — documents, the RTDB node and the
  files. Builds and people are untouched.
-->
<script lang="ts">
  import {
    ChevronRight,
    Database,
    File as FileIcon,
    FolderTree,
    RotateCw,
    Trash2,
  } from 'lucide-svelte';
  import {
    artifactFirestoreCollection,
    artifactFirestoreDoc,
    artifactRtdbPath,
    splitArtifactPath,
  } from '@tm/shared';
  import { relativeTime } from '$lib/account/format';
  import { command } from '$lib/api';
  import Section from '$lib/board/settings/Section.svelte';
  import { formatBytes } from '$lib/editor/upload';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import { toDriverError, type StoredFile } from '../broker';
  import { fromStored } from '../convert';
  import { firebaseBackend } from '../firebaseBackend';
  import { useArtifactSettings } from './context.svelte';
  import JsonTree from './JsonTree.svelte';

  const s = useArtifactSettings();
  const a = $derived(s.artifact);
  const backend = $derived(firebaseBackend(a.id));
  const PAGE = 50;
  /** What went wrong, in the words the artifact itself would get. */
  const say = (e: unknown) => toDriverError(e).message;

  // ── Firestore ──────────────────────────────────────────────────────────────
  type Row = { id: string; data: unknown };
  let fsPath = $state('');
  let fsBusy = $state(false);
  let fsError = $state<string | null>(null);
  let fsView = $state.raw<
    | { kind: 'collection'; path: string; rows: Row[]; more: boolean }
    | { kind: 'doc'; path: string; exists: boolean; data: unknown }
    | null
  >(null);

  const clean = (p: string) => `/${splitArtifactPath(p).join('/')}`;

  async function browse(target = fsPath, after?: string) {
    fsBusy = true;
    fsError = null;
    try {
      const segs = splitArtifactPath(target);
      if (!segs.length)
        throw new Error('Type a collection (“/todos”) or a document (“/todos/abc”).');
      const path = clean(target);
      fsPath = path;
      if (segs.length % 2 === 1) {
        const rows = await backend.fs.list(artifactFirestoreCollection(a.id, path), {
          where: [],
          orderBy: null,
          limit: PAGE,
          startAfter: after ?? null,
        });
        const mapped = rows.map((r) => ({ id: r.id, data: fromStored(r.data, backend.fs.asDate) }));
        const before =
          after && fsView?.kind === 'collection' && fsView.path === path ? fsView.rows : [];
        fsView = {
          kind: 'collection',
          path,
          rows: [...before, ...mapped],
          more: rows.length === PAGE,
        };
      } else {
        const snap = await backend.fs.get(artifactFirestoreDoc(a.id, path));
        fsView = {
          kind: 'doc',
          path,
          exists: snap.exists,
          data: fromStored(snap.data, backend.fs.asDate),
        };
      }
    } catch (e) {
      fsView = null;
      fsError = say(e);
    } finally {
      fsBusy = false;
    }
  }
  const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

  // ── Realtime Database ──────────────────────────────────────────────────────
  let rtPath = $state('/');
  let rtBusy = $state(false);
  let rtError = $state<string | null>(null);
  let rtView = $state.raw<{ path: string; value: unknown } | null>(null);

  async function loadRtdb() {
    rtBusy = true;
    rtError = null;
    try {
      const path = clean(rtPath);
      rtPath = path;
      rtView = { path, value: (await backend.rtdb.get(artifactRtdbPath(a.id, path))) ?? null };
    } catch (e) {
      rtView = null;
      rtError = say(e);
    } finally {
      rtBusy = false;
    }
  }

  // ── files ──────────────────────────────────────────────────────────────────
  let files = $state.raw<StoredFile[] | null>(null);
  let filesBusy = $state(false);
  let filesError = $state<string | null>(null);
  async function loadFiles() {
    filesBusy = true;
    filesError = null;
    try {
      files = await backend.files.list('');
    } catch (e) {
      files = null;
      filesError = say(e);
    } finally {
      filesBusy = false;
    }
  }
  async function openFile(f: StoredFile) {
    try {
      const { url } = await backend.files.url(f.path);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast.error('Could not open the file', say(e));
    }
  }
  const totalBytes = $derived((files ?? []).reduce((n, f) => n + f.size, 0));

  // ── delete all data ────────────────────────────────────────────────────────
  let clearOpen = $state(false);
  let confirmText = $state('');
  let clearing = $state(false);
  const confirmed = $derived(confirmText.trim() === a.name);
  async function clearAll() {
    if (!confirmed) return;
    clearing = true;
    try {
      await command(
        'artifactDataClear',
        { artifactId: a.id },
        { toast: 'Could not delete the data' },
      );
      clearOpen = false;
      fsView = null;
      rtView = null;
      files = null;
      toast.success('All data deleted', 'Builds and people are untouched.');
    } catch {
      /* toasted */
    } finally {
      clearing = false;
    }
  }
</script>

<Section
  title="Data"
  description="What this artifact has stored — read-only. Everything lives under the artifact's own prefix; its code cannot reach anything else."
>
  <div class="flex flex-col gap-8">
    <section class="flex flex-col gap-3" aria-labelledby="data-fs">
      <h3 id="data-fs" class="flex items-center gap-1.5 font-medium">
        <Database size={15} /> Firestore
      </h3>
      <form class="flex flex-wrap items-end gap-2" onsubmit={(e) => (e.preventDefault(), browse())}>
        <Input
          label="Path"
          bind:value={fsPath}
          placeholder="/todos   or   /todos/abc123"
          class="min-w-64 flex-1"
          inputClass="font-mono"
          autocomplete="off"
          spellcheck="false"
          hint="A collection has an odd number of segments, a document an even number. Collections cannot be discovered from the browser — name the one the artifact uses."
        />
        <Button type="submit" variant="primary" loading={fsBusy} class="mb-6">Open</Button>
      </form>
      {#if fsError}
        <p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          {fsError}
        </p>
      {:else if fsView?.kind === 'collection'}
        <div class="rounded-xl border border-line bg-surface">
          <p class="border-b border-line px-4 py-2 text-xs text-muted">
            <span class="font-mono">{fsView.path}</span> · {fsView.rows.length}{fsView.more
              ? '+'
              : ''}
            {fsView.rows.length === 1 ? 'document' : 'documents'}
          </p>
          {#if !fsView.rows.length}
            <p class="px-4 py-3 text-sm text-muted">No documents here.</p>
          {:else}
            <ul class="divide-y divide-line">
              {#each fsView.rows as r (r.id)}
                <li class="px-4 py-2">
                  <button
                    type="button"
                    class="flex items-center gap-1 font-mono text-xs text-accent hover:underline"
                    onclick={() => browse(`${fsView!.path}/${r.id}`)}
                  >
                    {r.id}
                    <ChevronRight size={12} aria-hidden="true" />
                  </button>
                  <JsonTree value={r.data} depth={1} />
                </li>
              {/each}
            </ul>
          {/if}
          {#if fsView.more}
            <div class="border-t border-line px-4 py-2">
              <Button
                size="sm"
                variant="ghost"
                loading={fsBusy}
                onclick={() =>
                  fsView?.kind === 'collection' &&
                  browse(fsView.path, fsView.rows[fsView.rows.length - 1]?.id)}>Next {PAGE}</Button
              >
            </div>
          {/if}
        </div>
      {:else if fsView?.kind === 'doc'}
        <div class="rounded-xl border border-line bg-surface">
          <p class="flex items-center gap-2 border-b border-line px-4 py-2 text-xs text-muted">
            <span class="font-mono">{fsView.path}</span>
            <button
              type="button"
              class="text-accent hover:underline"
              onclick={() => fsView && browse(parent(fsView.path))}>↑ its collection</button
            >
          </p>
          <div class="px-4 py-3">
            {#if fsView.exists}<JsonTree value={fsView.data} />{:else}
              <p class="text-sm text-muted">No document at this path.</p>
            {/if}
          </div>
        </div>
      {/if}
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="data-rt">
      <h3 id="data-rt" class="flex items-center gap-1.5 font-medium">
        <FolderTree size={15} /> Realtime Database
      </h3>
      <form
        class="flex flex-wrap items-end gap-2"
        onsubmit={(e) => (e.preventDefault(), loadRtdb())}
      >
        <Input
          label="Path"
          bind:value={rtPath}
          placeholder="/"
          class="min-w-64 flex-1"
          inputClass="font-mono"
          autocomplete="off"
          spellcheck="false"
          hint="“/” is everything the artifact keeps here. Nothing is fetched until you ask; name a deeper path if the tree is large."
        />
        <Button type="submit" loading={rtBusy} class="mb-6">Load</Button>
      </form>
      {#if rtError}
        <p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          {rtError}
        </p>
      {:else if rtView}
        <div class="rounded-xl border border-line bg-surface px-4 py-3">
          {#if rtView.value === null}
            <p class="text-sm text-muted">
              Nothing at <span class="font-mono">{rtView.path}</span>.
            </p>
          {:else}
            <JsonTree value={rtView.value} />
          {/if}
        </div>
      {/if}
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="data-files">
      <div class="flex items-center gap-3">
        <h3 id="data-files" class="flex items-center gap-1.5 font-medium">
          <FileIcon size={15} /> Files
        </h3>
        {#if files}
          <span class="text-sm text-muted"
            >{files.length}{files.length === 1000 ? '+' : ''} · {formatBytes(totalBytes)}</span
          >
        {/if}
        <Button
          size="sm"
          variant="ghost"
          icon={files ? RotateCw : undefined}
          loading={filesBusy}
          onclick={() => loadFiles()}>{files ? 'Refresh' : 'Show files'}</Button
        >
      </div>
      {#if filesError}
        <p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          {filesError}
        </p>
      {:else if files && !files.length}
        <p class="text-sm text-muted">The artifact has not uploaded any files.</p>
      {:else if files}
        <div class="overflow-x-auto rounded-xl border border-line bg-surface">
          <table class="w-full min-w-[32rem] text-sm">
            <thead class="border-b border-line text-left text-xs text-muted">
              <tr>
                <th class="px-4 py-2 font-medium">Path</th>
                <th class="px-2 py-2 font-medium">Size</th>
                <th class="px-2 py-2 font-medium">Type</th>
                <th class="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              {#each files as f (f.path)}
                <tr>
                  <td class="px-4 py-2">
                    <button
                      type="button"
                      class="font-mono text-xs break-all text-accent hover:underline"
                      onclick={() => openFile(f)}>{f.path}</button
                    >
                  </td>
                  <td class="px-2 py-2 whitespace-nowrap text-muted">{formatBytes(f.size)}</td>
                  <td class="px-2 py-2 text-muted">{f.contentType ?? '—'}</td>
                  <td class="px-4 py-2 whitespace-nowrap text-muted"
                    >{f.updatedAt ? relativeTime(f.updatedAt) : '—'}</td
                  >
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    {#if s.isOwner}
      <div
        class="flex max-w-2xl flex-wrap items-center gap-3 rounded-xl border border-danger/40 bg-surface p-5"
      >
        <div class="min-w-0 flex-1">
          <h3 class="font-medium">Delete all data</h3>
          <p class="text-sm text-muted">
            Every document, the Realtime Database and every uploaded file of this artifact, for
            everyone. Builds and people stay.
          </p>
        </div>
        <Button
          variant="danger"
          icon={Trash2}
          onclick={() => ((confirmText = ''), (clearOpen = true))}>Delete all data…</Button
        >
      </div>
    {/if}
  </div>
</Section>

<Dialog
  bind:open={clearOpen}
  title="Delete all of {a.name}'s data?"
  size="sm"
  description="This can't be undone. Type the artifact's name to confirm."
>
  <form id="clear-artifact" onsubmit={(e) => (e.preventDefault(), clearAll())}>
    <Input
      label="Name"
      value={confirmText}
      placeholder={a.name}
      autocomplete="off"
      oninput={(e) => (confirmText = e.currentTarget.value)}
    />
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (clearOpen = false)}>Cancel</Button>
    <Button
      variant="danger"
      type="submit"
      form="clear-artifact"
      disabled={!confirmed}
      loading={clearing}>Delete all data</Button
    >
  {/snippet}
</Dialog>

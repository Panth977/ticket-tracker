<!--
  The host page's DB tab: the artifact's Firestore data (artifacts/{id}/db/data/**),
  read-only, as three columns — the way a console draws it:

    Collections        Documents          Document
    ▸ settings         abc123             { … }  (JsonTree)
    ▸ todos  ●         def456  ●          Collections under it: steps · notes

  ?path= is where you are, in the artifact's own view ('/todos/def456'), so a
  document is linkable. An odd number of segments is a collection (its
  documents in the middle), an even number a document (its data on the right).
  Deeper paths shift the columns: the left one is always the collections of
  the parent document. On a phone only the deepest column shows.

  Collections come from artifactDataCollections (the client SDK cannot list
  them); documents are read in the viewer's session through the same fence and
  store functions as the broker — what the artifact's own db.firestore sees.
-->
<script lang="ts">
  // hrefs are built from this page's own URL (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { ChevronRight, Database, File as FileIcon, Folder, RotateCw } from 'lucide-svelte';
  import { page } from '$app/state';
  import { artifactFirestoreCollection, artifactFirestoreDoc, splitArtifactPath } from '@tm/shared';
  import { command } from '$lib/api';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { toDriverError } from '../broker';
  import { fromStored } from '../convert';
  import { firebaseBackend } from '../firebaseBackend';
  import JsonTree from '../settings/JsonTree.svelte';
  import { withParams, type ArtifactTabProps } from './index';

  let { artifactId }: ArtifactTabProps = $props();

  const backend = $derived(firebaseBackend(artifactId));
  const PAGE = 50;
  const say = (e: unknown) => toDriverError(e).message;

  // ── where I am ─────────────────────────────────────────────────────────────
  const segs = $derived.by(() => {
    try {
      return splitArtifactPath(page.url.searchParams.get('path') ?? '');
    } catch {
      return [];
    }
  });
  const join = (s: readonly string[]) => (s.length ? `/${s.join('/')}` : '');
  const isDoc = $derived(segs.length > 0 && segs.length % 2 === 0);
  /** The collection in the middle column ('' at the root: nothing picked yet). */
  const colPath = $derived(join(isDoc ? segs.slice(0, -1) : segs));
  /** The document whose collections are on the left ('' = the root). */
  const parentDoc = $derived(join(isDoc ? segs.slice(0, -2) : segs.slice(0, -1)));
  const docPath = $derived(isDoc ? join(segs) : '');
  const pickedCol = $derived(colPath ? colPath.slice(colPath.lastIndexOf('/') + 1) : null);
  const pickedDoc = $derived(isDoc ? segs[segs.length - 1]! : null);

  const href = (p: string) => withParams(page.url, { path: p || null });

  // ── reads ──────────────────────────────────────────────────────────────────
  /** Bumped by Refresh: every column reads again. */
  let round = $state(0);

  type Load<T> = { loading: boolean; error: string | null; data: T | null };
  const idle = <T,>(): Load<T> => ({ loading: true, error: null, data: null });

  let cols = $state.raw<Load<string[]>>(idle());
  $effect(() => {
    void round;
    const at = parentDoc;
    cols = idle();
    command('artifactDataCollections', { artifactId, path: at }, { toast: false }).then(
      (r) => at === parentDoc && (cols = { loading: false, error: null, data: r.collections }),
      (e) => at === parentDoc && (cols = { loading: false, error: say(e), data: null }),
    );
  });

  let docs = $state.raw<Load<string[]> & { more: boolean }>({ ...idle(), more: false });
  async function loadDocs(path: string, after?: string) {
    try {
      const rows = await backend.fs.list(artifactFirestoreCollection(artifactId, path), {
        where: [],
        orderBy: null,
        limit: PAGE,
        startAfter: after ?? null,
      });
      if (path !== colPath) return;
      const ids = rows.map((r) => r.id);
      docs = {
        loading: false,
        error: null,
        data: after ? [...(docs.data ?? []), ...ids] : ids,
        more: rows.length === PAGE,
      };
    } catch (e) {
      if (path === colPath) docs = { loading: false, error: say(e), data: null, more: false };
    }
  }
  $effect(() => {
    void round;
    const at = colPath;
    docs = { ...idle(), more: false };
    if (at) void loadDocs(at);
  });

  let doc = $state.raw<Load<{ exists: boolean; data: unknown }>>(idle());
  let subs = $state.raw<string[]>([]);
  $effect(() => {
    void round;
    const at = docPath;
    doc = idle();
    subs = [];
    if (!at) return;
    backend.fs.get(artifactFirestoreDoc(artifactId, at)).then(
      (snap) =>
        at === docPath &&
        (doc = {
          loading: false,
          error: null,
          data: { exists: snap.exists, data: fromStored(snap.data, backend.fs.asDate) },
        }),
      (e) => at === docPath && (doc = { loading: false, error: say(e), data: null }),
    );
    command('artifactDataCollections', { artifactId, path: at }, { toast: false }).then(
      (r) => at === docPath && (subs = r.collections),
      () => {
        /* the document pane already says what went wrong, if anything did */
      },
    );
  });

  const rowClass = (on: boolean) =>
    `flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs ${
      on ? 'bg-surface-2 font-medium text-text' : 'text-muted hover:bg-surface-2 hover:text-text'
    }`;
</script>

<div class="flex min-h-0 flex-1 flex-col" data-artifact-tab="db">
  <nav
    class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-surface px-3 py-1.5 text-sm whitespace-nowrap"
    aria-label="Path"
  >
    <a
      href={href('')}
      class="flex items-center gap-1 rounded px-1 {segs.length
        ? 'text-muted hover:text-text'
        : 'font-medium text-text'}"><Database size={14} aria-hidden="true" /> Firestore</a
    >
    {#each segs as s, i (i)}
      <ChevronRight size={13} class="shrink-0 text-subtle" aria-hidden="true" />
      <a
        href={href(join(segs.slice(0, i + 1)))}
        class="rounded px-1 font-mono text-xs {i === segs.length - 1
          ? 'font-medium text-text'
          : 'text-muted hover:text-text'}">{s}</a
      >
    {/each}
    <span class="flex-1"></span>
    <IconButton icon={RotateCw} label="Refresh" size="sm" onclick={() => round++} />
  </nav>

  <div class="grid min-h-0 flex-1 md:grid-cols-[14rem_16rem_minmax(0,1fr)]">
    <!-- Collections of the parent document -->
    <section
      class="min-h-0 flex-col overflow-y-auto border-r border-line p-2 {colPath
        ? 'hidden md:flex'
        : 'flex'}"
      aria-label="Collections"
    >
      <h3 class="px-2 pb-1 text-xs font-medium text-subtle">
        {parentDoc ? `Collections in ${parentDoc}` : 'Collections'}
      </h3>
      {#if cols.loading}
        <Skeleton lines={4} />
      {:else if cols.error}
        <p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          {cols.error}
        </p>
      {:else if !cols.data?.length}
        <p class="px-2 text-sm text-muted">
          {parentDoc
            ? 'No collections under this document.'
            : 'The artifact has stored nothing yet.'}
        </p>
      {:else}
        {#each cols.data as c (c)}
          <a href={href(`${parentDoc}/${c}`)} class={rowClass(c === pickedCol)} data-collection={c}>
            <Folder size={13} class="shrink-0" aria-hidden="true" />
            <span class="truncate">{c}</span>
          </a>
        {/each}
      {/if}
    </section>

    <!-- Documents of the picked collection -->
    <section
      class="min-h-0 flex-col overflow-y-auto border-r border-line p-2 {colPath && !isDoc
        ? 'flex'
        : 'hidden md:flex'}"
      aria-label="Documents"
    >
      {#if !colPath}
        <p class="px-2 py-1 text-sm text-muted">Pick a collection.</p>
      {:else}
        <h3 class="truncate px-2 pb-1 text-xs font-medium text-subtle">
          {pickedCol}{docs.data ? ` · ${docs.data.length}${docs.more ? '+' : ''}` : ''}
        </h3>
        {#if docs.loading}
          <Skeleton lines={4} />
        {:else if docs.error}
          <p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
            {docs.error}
          </p>
        {:else if !docs.data?.length}
          <p class="px-2 text-sm text-muted">No documents here.</p>
        {:else}
          {#each docs.data as id (id)}
            <a href={href(`${colPath}/${id}`)} class={rowClass(id === pickedDoc)} data-doc={id}>
              <FileIcon size={13} class="shrink-0" aria-hidden="true" />
              <span class="truncate">{id}</span>
            </a>
          {/each}
          {#if docs.more}
            <Button
              size="sm"
              variant="ghost"
              class="mt-1"
              onclick={() => loadDocs(colPath, docs.data?.[docs.data.length - 1])}
              >Next {PAGE}</Button
            >
          {/if}
        {/if}
      {/if}
    </section>

    <!-- The picked document -->
    <section
      class="min-h-0 flex-col overflow-y-auto p-3 {isDoc ? 'flex' : 'hidden md:flex'}"
      aria-label="Document"
    >
      {#if !isDoc}
        <EmptyState
          icon={FileIcon}
          title="Pick a document"
          description="Its fields show here, read-only — exactly what the artifact's own db.firestore.get returns."
        />
      {:else if doc.loading}
        <Skeleton lines={6} />
      {:else if doc.error}
        <p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          {doc.error}
        </p>
      {:else if doc.data}
        <a
          href={href(colPath)}
          class="mb-2 flex items-center gap-1 text-sm text-muted hover:text-text md:hidden"
          >← {pickedCol}</a
        >
        <div class="rounded-xl border border-line bg-surface px-4 py-3" data-doc-json>
          {#if doc.data.exists}<JsonTree value={doc.data.data} />{:else}
            <p class="text-sm text-muted">No document at this path.</p>
          {/if}
        </div>
        {#if subs.length}
          <h3 class="mt-4 mb-1 text-xs font-medium text-subtle">Collections under it</h3>
          <div class="flex flex-wrap gap-1">
            {#each subs as c (c)}
              <a href={href(`${docPath}/${c}`)} class={rowClass(false)} data-subcollection={c}>
                <Folder size={13} class="shrink-0" aria-hidden="true" />{c}
              </a>
            {/each}
          </div>
        {/if}
      {/if}
    </section>
  </div>
</div>

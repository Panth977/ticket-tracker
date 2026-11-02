<!--
  The host page's CODE tab (owner and editors; docs/plan/artifacts.html §L): the whole
  artifact in one tree, frontend and backend, written, checked and published here.

    [Code · from build a1B2c3 · unpublished]   [Backend] [Check] [message…] [Publish]
    ┌ files │ editor (TypeScript, types of host.*) ┬ live preview ┬ routes, logs ┐
    └ problems · console ──────────────────────────┴──────────────┴──────────────┘

  /backend is the backend (./project): it compiles on the worker, in the sandbox, and
  everything else compiles here in the browser. Publish does both. The work in progress
  is kept as a draft in this browser until published.

  A build made outside the app shows its kept source: read only, because its tools live
  where it was made. Its backend, under /backend, stays editable.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Code2, Hammer, Server, Upload } from 'lucide-svelte';
  import { mountDev, type DevHandle } from '@panth977/sandbox/dev';
  import { command } from '$lib/api';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import Input from '$lib/ui/Input.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import { shortBuild } from '../store';
  import type { ArtifactTabProps } from '../tabs';
  import { KIT_CDN, kitBuildFiles, loadKitSources, type SourceFiles } from './build';
  import { getKitHost } from './context';
  import { TM_HOST_TYPES } from './hostTypes';
  import BackendPanel from './BackendPanel.svelte';
  import {
    BACKEND_API,
    BACKEND_ENTRY,
    backendFiles,
    backendProblems,
    backendTree,
    frontendFiles,
    hasBackend,
    isBackendPath,
    withBackend,
  } from './project';
  import { firstSourceFile, readSourceZip } from './sourceZip';
  import { KIT_TEMPLATES } from './templates';
  import { appTheme, onAppTheme } from './theme';

  let { artifactId }: ArtifactTabProps = $props();
  const kitHost = getKitHost();

  const DRAFT_KEY = $derived(`tm.kit.draft.${artifactId}`);

  /** kit: written here. source: a build made elsewhere, read only. none: backend alone. */
  type Frontend = 'kit' | 'source' | 'none';
  type Start =
    | { state: 'loading' }
    | { state: 'pick'; reason: 'empty' | 'classic' }
    | { state: 'ready'; files: SourceFiles; from: string; frontend: Frontend; skipped?: number };
  let start = $state<Start>({ state: 'loading' });
  type Backend = Awaited<ReturnType<typeof loadBackend>>;
  let backend = $state<Backend | null>(null);
  let withApi = $state(false);
  let showPanel = $state(false);
  let checking = $state(false);
  let routes = $state<string[]>([]);
  let events = $state<string[]>([]);
  let cpuMs = $state<number | null>(null);
  /** The frontend as last published, so a backend-only change makes no new build. */
  let publishedFront: string | null = null;

  async function loadBackend() {
    try {
      return await command('artifactBackendGet', { artifactId }, {});
    } catch {
      return { configured: false, url: null, backend: null, files: null, types: null };
    }
  }
  function applyBackend(b: Backend) {
    backend = b;
    routes = b.backend?.routes ?? [];
    events = b.backend?.events ?? [];
  }
  void loadBackend().then(applyBackend);
  let message = $state('');
  let publishing = $state(false);
  let dirty = $state(false);
  let el = $state<HTMLDivElement | null>(null);
  let dev: DevHandle | null = null;
  let preview: { close(): void } | null = null;
  let stopTheme: (() => void) | null = null;

  function readDraft(): { files: SourceFiles; base: string | null } | null {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw ? (JSON.parse(raw) as { files: SourceFiles; base: string | null }) : null;
    } catch {
      return null;
    }
  }
  /** The source last published from here (JSON), until the next real edit. */
  let published: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function saveDraft(files: SourceFiles) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(
          DRAFT_KEY,
          JSON.stringify({ files, base: kitHost?.opened()?.buildId ?? null }),
        );
      } catch {
        /* storage full or blocked: the draft lives only in memory */
      }
    }, 500);
  }
  function dropDraft() {
    clearTimeout(saveTimer);
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
  }

  // ── what to open: a draft, the current kit build's source, or a starter ───
  let decided = false;
  $effect(() => {
    if (decided || !kitHost || !backend) return;
    const opened = kitHost.opened();
    const kit = kitHost.kit();
    const live = backend.files;
    const draft = readDraft();
    if (draft && Object.keys(draft.files).length) {
      decided = true;
      dirty = true;
      const kitDraft = Object.keys(frontendFiles(draft.files)).length > 0;
      start = { state: 'ready', files: draft.files, from: 'draft', frontend: kitDraft ? 'kit' : 'none' };
      return;
    }
    if (!kitHost.hasBuild()) {
      if (live?.length) {
        decided = true;
        start = { state: 'ready', files: backendTree(live), from: 'the live backend', frontend: 'none' };
      } else start = { state: 'pick', reason: 'empty' };
      return;
    }
    if (!opened) return; // the Website is still opening the build
    if (kit === undefined) return; // still checking the build
    decided = true;
    if (kit === null) {
      void openKeptSource(opened.buildId);
      return;
    }
    loadKitSources(opened.contentUrl).then(
      (files) => {
        if (!files) return noSource();
        publishedFront = JSON.stringify(files);
        start = {
          state: 'ready',
          files: withBackend(files, live),
          from: `build ${shortBuild(opened.buildId)}`,
          frontend: 'kit',
        };
      },
      () => noSource(),
    );
  });

  /** Nothing to show of the frontend: the live backend alone, or the starters. */
  function noSource() {
    const live = backend?.files;
    if (live?.length) start = { state: 'ready', files: backendTree(live), from: 'the live backend', frontend: 'none' };
    else start = { state: 'pick', reason: 'classic' };
  }

  /** A build made elsewhere: show the source kept beside it, when there is one. */
  async function openKeptSource(buildId: string) {
    try {
      const { url } = await command('artifactSourceUrl', { artifactId, buildId }, {});
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const view = readSourceZip(new Uint8Array(await res.arrayBuffer()));
      if (!Object.keys(view.files).length) throw new Error('empty');
      start = {
        state: 'ready',
        files: withBackend(view.files, backend?.files),
        skipped: view.skipped,
        from: `build ${shortBuild(buildId)}`,
        frontend: 'source',
      };
    } catch {
      noSource();
    }
  }

  function useTemplate(id: string) {
    const t = KIT_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    decided = true;
    dirty = true;
    start = { state: 'ready', files: { ...t.files }, from: `${t.label} starter`, frontend: 'kit' };
  }

  function backendOnly() {
    decided = true;
    dirty = true;
    start = { state: 'ready', files: backendTree(), from: 'a new backend', frontend: 'none' };
  }

  function addBackend() {
    if (!dev) return;
    for (const [path, text] of Object.entries(backendTree())) dev.setFile(path, text);
    dev.openFile(BACKEND_ENTRY);
    withApi = true;
    showPanel = true;
  }

  // ── the dev engine ──────────────────────────────────────────────────────────
  $effect(() => {
    if (start.state !== 'ready' || !el || dev || !kitHost || !backend) return;
    const kitFront = start.frontend === 'kit';
    const readOnlyFront = start.frontend === 'source';
    const p = kitHost.previewApi();
    preview = p;
    withApi = hasBackend(start.files);
    showPanel = withApi;
    const theme = appTheme();
    for (const [k, v] of Object.entries(theme.vars ?? {})) el.style.setProperty(k, v);
    dev = mountDev(el, {
      files: start.files,
      open: kitFront ? undefined : (hasBackend(start.files) && start.frontend === 'none' ? BACKEND_ENTRY : firstSourceFile(start.files)),
      preview: kitFront,
      compileFilter: (path) => !isBackendPath(path),
      readOnlyPaths: (path) => path === BACKEND_API || (readOnlyFront && !isBackendPath(path)),
      api: p.api,
      hostTypes: `${TM_HOST_TYPES}\n${backend.types ?? ''}`,
      languageWorker: `${KIT_CDN}/dev/language-worker.js`,
      theme,
      network: ['*'],
      sandbox: ['allow-forms', 'allow-popups', 'allow-downloads', 'allow-modals'],
      onChange: (files) => {
        // a late echo of what was just published is not a change
        if (published !== null && JSON.stringify(files) === published) return;
        published = null;
        dirty = true;
        saveDraft(files);
      },
      onSave: () => void publish(),
    });
    stopTheme = onAppTheme((t) => {
      for (const [k, v] of Object.entries(t.vars ?? {})) el?.style.setProperty(k, v);
      void dev?.preview?.setTheme(t);
    });
  });

  /** Compile the backend on the worker. Problems land in the editor, on their lines. */
  async function buildBackend(files: SourceFiles, publish: boolean): Promise<boolean> {
    const r = await command(
      'artifactBackendBuild',
      { artifactId, files: backendFiles(files), publish },
      { toast: 'Could not build the backend' },
    );
    dev?.setProblems(backendProblems(r.diagnostics));
    if (!r.ok) {
      toast.error('Backend has errors', 'See Problems.');
      return false;
    }
    routes = r.routes;
    events = r.events;
    cpuMs = r.cpuMs;
    return true;
  }

  async function check() {
    if (!dev || checking) return;
    checking = true;
    try {
      if (await buildBackend(dev.files(), false)) toast.success('Backend is good', `${cpuMs} ms of CPU.`);
    } catch {
      /* toasted */
    } finally {
      checking = false;
    }
  }

  async function publish() {
    if (!dev || publishing || start.state !== 'ready') return;
    publishing = true;
    try {
      const files = dev.files();
      const kitFront = start.frontend === 'kit';
      const front = frontendFiles(files);
      const frontChanged = kitFront && JSON.stringify(front) !== publishedFront;
      const result = frontChanged ? await dev.build() : null;
      if (result && (!result.ok || !result.artifact)) {
        const n = result.diagnostics.filter((d) => d.severity === 'error').length;
        toast.error('Not published', `${n} error${n === 1 ? '' : 's'} — see Problems.`);
        return;
      }
      if (withApi && hasBackend(files)) {
        if (!(await buildBackend(files, true))) return;
        applyBackend(await loadBackend());
      }
      let buildId: string | null = null;
      if (result?.artifact) {
        const res = await command(
          'artifactPublish',
          {
            artifactId,
            files: kitBuildFiles(kitHost?.name() ?? 'Artifact', front, result.artifact),
            message: message.trim() || null,
          },
          { toast: 'Could not publish' },
        );
        buildId = res.buildId;
        publishedFront = JSON.stringify(front);
      }
      published = JSON.stringify(files);
      dropDraft();
      dirty = false;
      message = '';
      toast.success(
        'Published',
        buildId
          ? `Build ${shortBuild(buildId)} is current — the Website tab offers a reload.`
          : 'The backend is live.',
      );
    } catch {
      /* toasted */
    } finally {
      publishing = false;
    }
  }

  onDestroy(() => {
    clearTimeout(saveTimer);
    stopTheme?.();
    dev?.destroy();
    preview?.close();
  });
</script>

<div
  class="flex min-h-0 flex-1 flex-col"
  data-artifact-tab="code"
  data-source-view={start.state === 'ready' && start.frontend === 'source' ? '' : undefined}
>
  {#if start.state === 'ready'}
    <div
      class="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-sm"
    >
      <Code2 size={15} class="text-muted" aria-hidden="true" />
      <span class="truncate text-muted">
        From {start.from}{#if start.frontend === 'source'}. Frontend is read only: it was built
          outside this app, so change it where it was made.{#if start.skipped}
            {start.skipped} file{start.skipped === 1 ? '' : 's'} not shown.{/if}{/if}{#if dirty}<span
            class="text-subtle">&nbsp;· unpublished changes</span
          >{/if}
      </span>
      <span class="flex-1"></span>
      {#if backend?.configured}
        {#if withApi}
          <Button size="sm" icon={Server} onclick={() => (showPanel = !showPanel)}>Backend</Button>
          <Button size="sm" icon={Hammer} loading={checking} onclick={() => check()}>Check</Button>
        {:else}
          <Button size="sm" icon={Server} onclick={() => addBackend()}>Add backend</Button>
        {/if}
      {/if}
      <Input
        class="hidden w-56 sm:block"
        placeholder="What changed? (optional)"
        bind:value={message}
        aria-label="Publish message"
      />
      <Button
        size="sm"
        variant="primary"
        icon={Upload}
        loading={publishing}
        onclick={() => publish()}>Publish</Button
      >
    </div>
    <div class="flex min-h-0 flex-1">
      <div class="min-h-0 min-w-0 flex-1 p-2" bind:this={el} data-kit-dev></div>
      {#if withApi && showPanel && backend?.configured}
        <BackendPanel
          {artifactId}
          url={backend.url}
          live={!!backend.backend}
          {routes}
          {events}
          {cpuMs}
          onoff={() => void loadBackend().then(applyBackend)}
        />
      {/if}
    </div>
  {:else if start.state === 'pick'}
    <EmptyState
      icon={Code2}
      title={start.reason === 'classic'
        ? 'This artifact is a static build'
        : 'Write this artifact here'}
      description={start.reason === 'classic'
        ? 'Its current build was uploaded as a folder. Start code here and publishing it makes a new build (the old one stays in Settings › Builds to roll back to).'
        : 'Pick a starter. It runs as you type, with your data, and Publish makes it the current build.'}
    >
      {#snippet action()}
        <div class="flex flex-wrap justify-center gap-2">
          {#each KIT_TEMPLATES as t (t.id)}
            <Button onclick={() => useTemplate(t.id)} title={t.description}>{t.label}</Button>
          {/each}
          {#if backend?.configured}
            <Button icon={Server} onclick={() => backendOnly()}>Backend only</Button>
          {/if}
        </div>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="flex flex-1 items-center justify-center text-sm text-muted" aria-busy="true">
      Loading the code…
    </div>
  {/if}
</div>

<style>
  [data-kit-dev] :global(.sbx-dev) {
    height: 100%;
    min-height: 0;
  }
</style>

<!--
  The host page's CODE tab (owner and editors; docs/plan/artifacts.html §L):
  write the artifact here, see it run, publish it.

    [Code · from build a1B2c3 · draft saved]        [message…] [Publish]
    ┌ files │ editor (TypeScript, types of host.*) ┬ live preview ────────┐
    │                                              │ the kit's sandbox,    │
    │                                              │ real data, as you     │
    └ problems · console ──────────────────────────┴──────────────────────┘

  Everything runs in the browser: the kit compiles TS/TSX/Svelte here, the
  preview is the same sandbox the Website tab uses, through a broker of its
  own (same viewer, role and grants). Publish = artifactPublish with the
  build's files inline (./build): it becomes the current build, like any other.
  The work in progress is kept as a draft in this browser until published.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Code2, Upload } from 'lucide-svelte';
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
  import { KIT_TEMPLATES } from './templates';
  import { appTheme, onAppTheme } from './theme';

  let { artifactId }: ArtifactTabProps = $props();
  const kitHost = getKitHost();

  const DRAFT_KEY = $derived(`tm.kit.draft.${artifactId}`);

  type Start =
    | { state: 'loading' }
    | { state: 'pick'; reason: 'empty' | 'classic' }
    | { state: 'ready'; files: SourceFiles; from: string };
  let start = $state<Start>({ state: 'loading' });
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
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
  }

  // ── what to open: a draft, the current kit build's source, or a starter ───
  let decided = false;
  $effect(() => {
    if (decided || !kitHost) return;
    const opened = kitHost.opened();
    const kit = kitHost.kit();
    const draft = readDraft();
    if (draft && Object.keys(draft.files).length) {
      decided = true;
      dirty = true;
      start = { state: 'ready', files: draft.files, from: 'draft' };
      return;
    }
    if (!kitHost.hasBuild()) {
      start = { state: 'pick', reason: 'empty' };
      return;
    }
    if (!opened) return; // the Website is still opening the build
    if (kit === undefined) return; // still checking the build
    decided = true;
    if (kit === null) {
      start = { state: 'pick', reason: 'classic' };
      return;
    }
    loadKitSources(opened.contentUrl).then(
      (files) =>
        (start = files
          ? { state: 'ready', files, from: `build ${shortBuild(opened.buildId)}` }
          : { state: 'pick', reason: 'classic' }),
      () => (start = { state: 'pick', reason: 'classic' }),
    );
  });

  function useTemplate(id: string) {
    const t = KIT_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    decided = true;
    dirty = true;
    start = { state: 'ready', files: { ...t.files }, from: `${t.label} starter` };
  }

  // ── the dev engine ──────────────────────────────────────────────────────────
  $effect(() => {
    if (start.state !== 'ready' || !el || dev || !kitHost) return;
    const p = kitHost.previewApi();
    preview = p;
    const theme = appTheme();
    for (const [k, v] of Object.entries(theme.vars ?? {})) el.style.setProperty(k, v);
    dev = mountDev(el, {
      files: start.files,
      api: p.api,
      hostTypes: TM_HOST_TYPES,
      languageWorker: `${KIT_CDN}/dev/language-worker.js`,
      theme,
      network: ['*'],
      sandbox: ['allow-forms', 'allow-popups', 'allow-downloads', 'allow-modals'],
      onChange: (files) => {
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

  async function publish() {
    if (!dev || publishing) return;
    publishing = true;
    try {
      const result = await dev.build();
      if (!result.ok || !result.artifact) {
        const n = result.diagnostics.filter((d) => d.severity === 'error').length;
        toast.error('Not published', `${n} error${n === 1 ? '' : 's'} — see Problems.`);
        return;
      }
      const files = dev.files();
      const res = await command(
        'artifactPublish',
        {
          artifactId,
          files: kitBuildFiles(kitHost?.name() ?? 'Artifact', files, result.artifact),
          message: message.trim() || null,
        },
        { toast: 'Could not publish' },
      );
      dropDraft();
      dirty = false;
      message = '';
      toast.success(
        'Published',
        `Build ${shortBuild(res.buildId)} is current — the Website tab offers a reload.`,
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

<div class="flex min-h-0 flex-1 flex-col" data-artifact-tab="code">
  {#if start.state === 'ready'}
    <div
      class="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-sm"
    >
      <Code2 size={15} class="text-muted" aria-hidden="true" />
      <span class="truncate text-muted">
        From {start.from}{#if dirty}<span class="text-subtle">&nbsp;· unpublished changes</span
          >{/if}
      </span>
      <span class="flex-1"></span>
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
    <div class="min-h-0 flex-1 p-2" bind:this={el} data-kit-dev></div>
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

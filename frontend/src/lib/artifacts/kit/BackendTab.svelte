<!--
  The BACKEND tab (owner and editors): code that runs on the worker, in a sandbox.

    [Backend · live at https://…/sandbox/{id}]       [Build] [Publish]
    ┌ files │ editor (TypeScript, types of sandboxApi) ┬ routes · logs ─┐
    └ problems ────────────────────────────────────────┴────────────────┘

  Build compiles there, for real, under CPU limits: errors come back here with
  their lines. Publish does the same and makes a good build live. Nothing runs in
  the browser: the kit's editor is only an editor here.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Hammer, Power, RefreshCw, Server, Upload } from 'lucide-svelte';
  import { mountDev, type DevHandle } from '@panth977/sandbox/dev';
  import {
    ARTIFACT_BACKEND_ENTRY,
    ARTIFACT_BACKEND_SANDBOX_API,
    ARTIFACT_BACKEND_STARTER,
    type ArtifactBackend,
    type ArtifactBackendLog,
  } from '@tm/shared';
  import { command } from '$lib/api';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import type { ArtifactTabProps } from '../tabs';
  import { KIT_CDN } from './build';
  import { appTheme, onAppTheme } from './theme';

  let { artifactId }: ArtifactTabProps = $props();

  type Loaded = {
    configured: boolean;
    url: string | null;
    backend: ArtifactBackend | null;
    files: Record<string, string> | null;
    types: string | null;
  };
  let info = $state<Loaded | null>(null);
  let failed = $state(false);
  let busy = $state<'build' | 'publish' | null>(null);
  let routes = $state<string[]>([]);
  let events = $state<string[]>([]);
  let cpuMs = $state<number | null>(null);
  let logs = $state<ArtifactBackendLog[]>([]);
  let running = $state(false);
  let el = $state<HTMLDivElement | null>(null);
  let dev: DevHandle | null = null;
  let stopTheme: (() => void) | null = null;

  async function load() {
    try {
      const r = await command('artifactBackendGet', { artifactId }, {});
      info = {
        ...r,
        files: r.files ? Object.fromEntries(r.files.map((f) => [`/${f.path}`, f.content])) : null,
      };
      routes = r.backend?.routes ?? [];
      events = r.backend?.events ?? [];
    } catch {
      failed = true;
    }
  }
  void load();

  $effect(() => {
    if (!info?.configured || !el || dev) return;
    const theme = appTheme();
    for (const [k, v] of Object.entries(theme.vars ?? {})) el.style.setProperty(k, v);
    dev = mountDev(el, {
      files: {
        [`/${ARTIFACT_BACKEND_ENTRY}`]: ARTIFACT_BACKEND_STARTER,
        ...info.files,
        '/sandboxApi.ts': ARTIFACT_BACKEND_SANDBOX_API,
      },
      open: `/${ARTIFACT_BACKEND_ENTRY}`,
      preview: false,
      api: {},
      hostTypes: info.types ?? '',
      languageWorker: `${KIT_CDN}/dev/language-worker.js`,
      theme,
      onSave: () => void build(true),
    });
    stopTheme = onAppTheme((t) => {
      for (const [k, v] of Object.entries(t.vars ?? {})) el?.style.setProperty(k, v);
    });
  });

  async function build(publish: boolean) {
    if (!dev || busy) return;
    busy = publish ? 'publish' : 'build';
    try {
      const files = Object.entries(dev.files())
        .filter(([path]) => path !== '/sandboxApi.ts')
        .map(([path, content]) => ({ path: path.replace(/^\//, ''), content }));
      const r = await command(
        'artifactBackendBuild',
        { artifactId, files, publish },
        { toast: 'Could not build' },
      );
      dev.setProblems(
        r.diagnostics.map((d) => ({
          ...d,
          file: d.file ? `/${d.file}` : undefined,
          source: d.source as never,
        })),
      );
      if (!r.ok) {
        toast.error('Build failed', 'See Problems.');
        return;
      }
      routes = r.routes;
      events = r.events;
      cpuMs = r.cpuMs;
      if (publish) {
        toast.success('Live', `${r.routes.length} route${r.routes.length === 1 ? '' : 's'}.`);
        await load();
      } else toast.success('Build is good', `${r.cpuMs} ms of CPU.`);
    } catch {
      /* toasted */
    } finally {
      busy = null;
    }
  }

  async function refreshLogs() {
    try {
      const r = await command('artifactBackendLogs', { artifactId }, {});
      logs = r.entries.slice(-100).reverse();
      running = r.running;
    } catch {
      /* the worker is away: the button stays */
    }
  }

  async function disable() {
    await command('artifactBackendDisable', { artifactId }, { toast: 'Could not turn it off' });
    toast.success('Backend off', 'Its routes are down.');
    await load();
  }

  onDestroy(() => {
    stopTheme?.();
    dev?.destroy();
  });
</script>

<div class="flex min-h-0 flex-1 flex-col" data-artifact-tab="backend">
  {#if failed}
    <EmptyState icon={Server} title="Could not open the backend" description="Try again in a moment." />
  {:else if !info}
    <div class="flex flex-1 items-center justify-center text-sm text-muted" aria-busy="true">
      Loading the backend…
    </div>
  {:else if !info.configured}
    <EmptyState
      icon={Server}
      title="Backends are not set up here"
      description="This deploy has no worker machine to run them on yet."
    />
  {:else}
    <div class="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-sm">
      <Server size={15} class="text-muted" aria-hidden="true" />
      {#if info.backend}
        <span class="truncate" data-backend-url>{info.url}</span>
      {:else}
        <span class="text-muted">Not live yet</span>
      {/if}
      <span class="flex-1"></span>
      {#if info.backend}
        <Button size="sm" icon={Power} onclick={() => disable()}>Turn off</Button>
      {/if}
      <Button size="sm" icon={Hammer} loading={busy === 'build'} onclick={() => build(false)}>Build</Button>
      <Button
        size="sm"
        variant="primary"
        icon={Upload}
        loading={busy === 'publish'}
        onclick={() => build(true)}>Publish</Button
      >
    </div>
    <div class="flex min-h-0 flex-1">
      <div class="min-h-0 min-w-0 flex-1 p-2" bind:this={el} data-kit-dev></div>
      <aside class="hidden w-72 shrink-0 flex-col overflow-auto border-l border-line p-3 text-sm md:flex">
        <h3 class="font-medium">Routes</h3>
        {#if routes.length}
          <ul class="mt-1 space-y-0.5 font-mono text-xs" data-backend-routes>
            {#each routes as r (r)}<li class="truncate">{r}</li>{/each}
          </ul>
        {:else}
          <p class="mt-1 text-muted">Build to find them.</p>
        {/if}
        {#if events.length}
          <h3 class="mt-4 font-medium">Events</h3>
          <ul class="mt-1 space-y-0.5 font-mono text-xs">
            {#each events as e (e)}<li class="truncate">{e}</li>{/each}
          </ul>
        {/if}
        {#if cpuMs !== null}<p class="mt-4 text-muted">Last build: {cpuMs} ms of CPU</p>{/if}
        <div class="mt-4 flex items-center justify-between">
          <h3 class="font-medium">Logs{running ? ' · running' : ''}</h3>
          <Button size="sm" icon={RefreshCw} onclick={() => refreshLogs()}>Refresh</Button>
        </div>
        <ul class="mt-1 space-y-1 font-mono text-xs">
          {#each logs as l, i (i)}
            <li class="break-words"><span class="text-muted">{l.kind}</span> {l.text}</li>
          {/each}
        </ul>
      </aside>
    </div>
  {/if}
</div>

<style>
  [data-kit-dev] :global(.sbx-dev) {
    height: 100%;
    min-height: 0;
  }
</style>

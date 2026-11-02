<!--
  The Code tab for a build made outside the app: its kept source, read only. It
  cannot be rebuilt here, because its tools and packages live where it was made.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { FileCode2 } from 'lucide-svelte';
  import { mountDev, type DevHandle } from '@panth977/sandbox/dev';
  import type { SourceFiles } from './build';
  import { firstSourceFile } from './sourceZip';
  import { appTheme, onAppTheme } from './theme';

  let { files, from, skipped }: { files: SourceFiles; from: string; skipped: number } = $props();

  let el = $state<HTMLDivElement | null>(null);
  let dev: DevHandle | null = null;
  let stopTheme: (() => void) | null = null;

  $effect(() => {
    if (!el || dev) return;
    const theme = appTheme();
    for (const [k, v] of Object.entries(theme.vars ?? {})) el.style.setProperty(k, v);
    dev = mountDev(el, {
      files,
      open: firstSourceFile(files),
      preview: false,
      readOnly: true,
      api: {},
      languageWorker: false,
      theme,
    });
    stopTheme = onAppTheme((t) => {
      for (const [k, v] of Object.entries(t.vars ?? {})) el?.style.setProperty(k, v);
    });
  });

  onDestroy(() => {
    stopTheme?.();
    dev?.destroy();
  });
</script>

<div class="flex min-h-0 flex-1 flex-col" data-artifact-tab="code" data-source-view>
  <div class="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-sm">
    <FileCode2 size={15} class="text-muted" aria-hidden="true" />
    <span class="truncate text-muted">
      Source of {from}, read only. It was built outside this app, so change it where it was made.{#if skipped}
        {skipped} file{skipped === 1 ? '' : 's'} not shown.{/if}
    </span>
  </div>
  <div class="min-h-0 flex-1 p-2" bind:this={el} data-kit-dev></div>
</div>

<style>
  [data-kit-dev] :global(.sbx-dev) {
    height: 100%;
    min-height: 0;
  }
</style>

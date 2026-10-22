<!--
  A KIT ARTIFACT on screen (docs/plan/artifacts.html §L): the kit's render
  engine (@panth977/sandbox/host mount) in place of the classic iframe.

  Same fence as the classic frame — `sandbox` without allow-same-origin, an
  opaque origin, no session — but the code arrives as the compiled artifact
  (fetched through the build's capability URL) and every call goes over the
  kit's private MessagePort to `api`, which is THE BROKER in a new shape
  (./bridgeApi). The app's theme (tokens and light/dark) is handed over at boot
  and live after.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { mount, type ArtifactHandle } from '@panth977/sandbox/host';
  import type { CompiledArtifact } from '@panth977/sandbox/protocol';
  import { appTheme, onAppTheme } from './theme';

  let {
    artifact,
    makeApi,
    title,
  }: { artifact: CompiledArtifact; makeApi: () => object; title: string } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let handle: ArtifactHandle | null = null;
  let stopTheme: (() => void) | null = null;

  $effect(() => {
    if (!host || handle) return;
    handle = mount(host, {
      artifact,
      api: makeApi(),
      title,
      size: 'fill',
      theme: appTheme(),
      // Like the classic frame: forms, links out, downloads, alert/confirm.
      sandbox: ['allow-forms', 'allow-popups', 'allow-downloads', 'allow-modals'],
      // The classic sandbox has no network fence either; the manifest's list is what it asks for.
      network: ['*'],
      onOpen: (url) => openOut(url),
      onConsole: (e) => console[e.level === 'debug' ? 'log' : e.level]?.(`[artifact]`, ...e.args),
      onError: (e) => console.warn('[artifact]', e.message, e.stack ?? ''),
    });
    stopTheme = onAppTheme((t) => void handle?.setTheme(t));
  });

  function openOut(url: string) {
    try {
      const u = new URL(url, window.location.origin);
      if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:')
        window.open(u.href, '_blank', 'noopener,noreferrer');
    } catch {
      /* not a URL */
    }
  }

  onDestroy(() => {
    stopTheme?.();
    handle?.destroy();
  });
</script>

<div bind:this={host} class="relative min-h-0 w-full flex-1" data-kit-frame></div>

<style>
  [data-kit-frame] > :global(iframe) {
    position: absolute;
    inset: 0;
    height: 100% !important;
  }
</style>

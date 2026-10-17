<!--
  The host page's JSON tab: the artifact's Realtime Database node
  (artifactData/{id}/…, what its db.rtdb.* calls read and write), LIVE, as a
  collapsible tree. ?path= narrows it to a deeper node when the whole tree is
  large; branches below the first level render only when opened (JsonTree).

  The listener is the viewer's own, through the same fence as the broker
  (artifactRtdbPath) — the rules decide, as for the artifact itself.
-->
<script lang="ts">
  // goto() targets are built from this page's own URL (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { artifactRtdbPath, splitArtifactPath } from '@tm/shared';
  import Button from '$lib/ui/Button.svelte';
  import Input from '$lib/ui/Input.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { toDriverError } from '../broker';
  import { firebaseBackend } from '../firebaseBackend';
  import JsonTree from '../settings/JsonTree.svelte';
  import { withParams, type ArtifactTabProps } from './index';

  let { artifactId }: ArtifactTabProps = $props();

  const backend = $derived(firebaseBackend(artifactId));
  const path = $derived(page.url.searchParams.get('path') || '/');

  /** What the box says: the URL's path until someone types (writable derived). */
  let typed = $derived(path);

  let live = $state.raw<{ path: string; value: unknown } | null>(null);
  let error = $state<string | null>(null);
  $effect(() => {
    const at = path;
    live = null;
    error = null;
    try {
      return backend.rtdb.on(
        artifactRtdbPath(artifactId, at),
        (value) => (live = { path: at, value: value ?? null }),
        (e) => (error = toDriverError(e).message),
      );
    } catch (e) {
      error = toDriverError(e).message;
    }
  });

  function open() {
    let clean: string;
    try {
      clean = `/${splitArtifactPath(typed).join('/')}`;
    } catch (e) {
      error = toDriverError(e).message;
      return;
    }
    void goto(withParams(page.url, { path: clean === '/' ? null : clean }), {
      keepFocus: true,
      noScroll: true,
    });
  }
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 sm:p-4" data-artifact-tab="json">
  <form class="flex flex-wrap items-end gap-2" onsubmit={(e) => (e.preventDefault(), open())}>
    <Input
      label="Path"
      bind:value={typed}
      placeholder="/"
      class="min-w-64 flex-1"
      inputClass="font-mono"
      autocomplete="off"
      spellcheck="false"
      hint="“/” is everything the artifact keeps in its Realtime Database. Live: changes show as they happen."
    />
    <Button type="submit" class="mb-6">Open</Button>
  </form>
  {#if error}
    <p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">{error}</p>
  {:else if !live}
    <Skeleton lines={5} />
  {:else}
    <div class="rounded-xl border border-line bg-surface px-4 py-3" data-rtdb-json>
      {#if live.value === null}
        <p class="text-sm text-muted">Nothing at <span class="font-mono">{live.path}</span>.</p>
      {:else}
        <JsonTree value={live.value} />
      {/if}
    </div>
  {/if}
</div>

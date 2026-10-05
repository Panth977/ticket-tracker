<!--
  One file as a preview card (agents.html §I), chosen by its kind:
    image     thumbnail            video   poster frame + duration
    audio     inline mini player   markdown  title + first lines, rendered
    html      live scaled-down preview (sandboxed iframe, never same-origin)
    pdf       first page (server thumbnail, else the browser's viewer, scaled)
    text / code / json / csv   first lines, highlighted
    other     icon + size
  Click opens the in-app viewer (onopen); Download / Open in new tab on hover.
  Previews load only when the card nears the viewport.
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- file URLs are external */
  import type { Snippet } from 'svelte';
  import { Download, ExternalLink } from 'lucide-svelte';
  import { formatBytes, parseMemoryRefPath } from '@tm/shared';
  import { markdownTitle } from '$lib/editor';
  import { toast } from '$lib/ui';
  import { KIND_LABEL, infoOf } from './kinds';
  import { fileIcon } from './fileIcons';
  import { downloadFile } from './source';
  import { visible } from './visible';
  import FilePreview from './FilePreview.svelte';
  import type { ViewerFile } from './types';

  interface Props {
    file: ViewerFile;
    onopen?: (file: ViewerFile) => void;
    /** /f/… for 'Open in new tab'; null hides it. */
    href?: string | null;
    /** Still uploading / not posted: no actions. */
    disabled?: boolean;
    /** Extra actions (e.g. the Files tab's 'Show message'). */
    extra?: Snippet;
  }
  let { file, onopen, href = null, disabled = false, extra }: Props = $props();

  const info = $derived(infoOf(file));
  const kind = $derived(info.kind);
  const fi = $derived(fileIcon(file));

  let shown = $state(false);
  let url = $state<string | null>(null);
  let text = $state<string | null>(null);
  /** memory.html §E: a memory reference that no longer resolves (FilePreview finds out). */
  let gone = $state(false);
  const fromMemory = $derived(!!file.memory || !!parseMemoryRefPath(file.path));
  const mdTitle = $derived(kind === 'markdown' && text ? markdownTitle(text) : null);

  function open() {
    if (!disabled) onopen?.(file);
  }
  async function download(e: MouseEvent) {
    e.stopPropagation();
    if (!(await downloadFile(file))) toast.error('Could not download the file');
  }
</script>

<div
  use:visible={(on) => (shown = on)}
  class="group/card relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface text-left transition-colors hover:border-line-strong
    {disabled ? 'opacity-70' : ''}"
  data-kind={kind}
>
  <!-- Preview area; a transparent button over it opens the viewer (previews may hold their own markup, never nested in a button). -->
  <div class="relative block h-32 w-full overflow-hidden bg-surface-2 text-left">
    <FilePreview {file} {shown} {disabled} bind:url bind:text bind:gone />
    {#if fromMemory}
      <span
        class="pointer-events-none absolute bottom-1.5 left-1.5 z-[1] rounded bg-surface/90 px-1.5 py-0.5 text-[10px] font-medium text-text shadow-pop"
        title="From memory: always its current version"
        data-memory-badge>🧠 Memory</span
      >
    {/if}
    <button
      type="button"
      class="absolute inset-0 size-full cursor-pointer focus-visible:outline-2 focus-visible:outline-accent"
      onclick={open}
      {disabled}
      aria-label="Open {file.name}"
    ></button>
  </div>

  {#if kind === 'audio' && url}
    <!-- The mini player: plays in place, the card's title still opens the viewer. -->
    <audio
      src={url}
      controls
      preload="none"
      class="h-8 w-full px-1 pt-1"
      aria-label="Play {file.name}"
    ></audio>
  {/if}

  <div class="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
    <fi.icon size={14} class="shrink-0 {fi.tone}" aria-hidden="true" />
    <button type="button" class="min-w-0 flex-1 text-left" onclick={open} {disabled} tabindex="-1">
      <span class="block truncate text-xs font-medium" title={file.name}
        >{mdTitle ?? file.name}</span
      >
      <span class="block truncate text-[11px] text-muted">
        {#if mdTitle}{file.name} ·
        {/if}{KIND_LABEL[kind]} · {formatBytes(file.size)}
      </span>
    </button>
  </div>

  {#if !disabled}
    <div
      class="absolute top-1.5 right-1.5 z-[2] hidden items-center gap-0.5 rounded-md border border-line bg-surface/95 p-0.5 shadow-pop group-focus-within/card:flex group-hover/card:flex"
    >
      {@render extra?.()}
      {#if href}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an app path built by fileViewerPath; the SPA has no base path -->
        <a
          {href}
          target="_blank"
          rel="noopener"
          class="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
          aria-label="Open {file.name} in a new tab"
          title="Open in new tab"
        >
          <ExternalLink size={14} />
        </a>
      {/if}
      <button
        type="button"
        class="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
        aria-label="Download {file.name}"
        title="Download"
        onclick={download}
      >
        <Download size={14} />
      </button>
    </div>
  {/if}
</div>

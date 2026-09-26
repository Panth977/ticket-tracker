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
  /* eslint-disable svelte/no-navigation-without-resolve, svelte/no-at-html-tags -- file URLs are external; highlightCode() escapes its input */
  import type { Snippet } from 'svelte';
  import { Download, ExternalLink, Play } from 'lucide-svelte';
  import { HTML_SANDBOX, formatBytes } from '@tm/shared';
  import { Markdown, highlightCode, markdownExcerpt, markdownTitle } from '$lib/editor';
  import { toast } from '$lib/ui';
  import {
    CARD_HTML_BYTES,
    CARD_NEEDS_TEXT,
    CARD_TEXT_BYTES,
    KIND_ICON,
    KIND_LABEL,
    firstLines,
    formatDuration,
    infoOf,
    prettyJson,
  } from './kinds';
  import { downloadFile, fileText, fileUrl } from './source';
  import { visible } from './visible';
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
  const Icon = $derived(KIND_ICON[kind]);

  let shown = $state(false);
  let url = $state<string | null>(null);
  let thumb = $state<string | null>(null);
  let text = $state<string | null>(null);
  let failed = $state(false);
  let duration = $state<number | null>(null);

  $effect(() => {
    if (!shown || disabled) return;
    const f = file;
    const k = kind;
    let alive = true;
    if (k === 'image' || k === 'video' || k === 'audio' || k === 'pdf') {
      void fileUrl(f.path).then((u) => alive && (url = u));
    }
    if ((k === 'image' || k === 'pdf' || k === 'video') && f.thumbPath) {
      void fileUrl(f.thumbPath).then((u) => alive && (thumb = u));
    }
    if (CARD_NEEDS_TEXT.has(k)) {
      fileText(f, k === 'html' ? CARD_HTML_BYTES : CARD_TEXT_BYTES)
        .then((r) => alive && (text = r.text))
        .catch(() => alive && (failed = true));
    }
    return () => {
      alive = false;
    };
  });

  const excerpt = $derived.by(() => {
    if (text == null) return null;
    if (kind === 'json') return firstLines(prettyJson(text), 14);
    return firstLines(text, 14);
  });
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
    {#if kind === 'image' && (thumb || url)}
      <img src={thumb ?? url} alt={file.name} class="size-full object-cover" loading="lazy" />
    {:else if kind === 'video' && url}
      {#if thumb}
        <img src={thumb} alt="" class="size-full object-cover" />
      {:else}
        <!-- #t=0.1 makes browsers paint the first frame as the poster. -->
        <video
          src="{url}#t=0.1"
          preload="metadata"
          muted
          playsinline
          class="pointer-events-none size-full bg-black object-cover"
          onloadedmetadata={(e) => (duration = e.currentTarget.duration)}
        ></video>
      {/if}
      <span class="absolute inset-0 grid place-items-center">
        <span class="grid size-10 place-items-center rounded-full bg-black/55 text-white"
          ><Play size={18} /></span
        >
      </span>
      {#if duration}
        <span
          class="absolute right-1.5 bottom-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white"
          >{formatDuration(duration)}</span
        >
      {/if}
    {:else if kind === 'html' && text != null}
      <!-- 1280×800 page, scaled into the card; scripts run, but the frame is an opaque origin and ignores the pointer. -->
      <span
        class="pointer-events-none absolute top-0 left-0 block origin-top-left"
        style="width:1280px;height:800px;transform:scale(0.2)"
      >
        <iframe
          title="Preview of {file.name}"
          sandbox={HTML_SANDBOX}
          srcdoc={text}
          referrerpolicy="no-referrer"
          loading="lazy"
          tabindex="-1"
          class="size-full border-0 bg-white"
        ></iframe>
      </span>
    {:else if kind === 'pdf' && thumb}
      <img src={thumb} alt="" class="size-full object-cover object-top" />
    {:else if kind === 'pdf' && url}
      <span
        class="pointer-events-none absolute top-0 left-0 block origin-top-left"
        style="width:600px;height:640px;transform:scale(0.4)"
      >
        <iframe
          title="First page of {file.name}"
          src="{url}#page=1&toolbar=0&navpanes=0&view=FitH"
          tabindex="-1"
          class="size-full border-0 bg-white"
        ></iframe>
      </span>
    {:else if kind === 'markdown' && excerpt != null}
      <div class="h-full overflow-hidden bg-surface px-3 pt-2 [&_.md-copy]:hidden">
        <Markdown
          source={markdownExcerpt(excerpt, 14)}
          class="pointer-events-none text-[11px] leading-snug"
        />
      </div>
    {:else if (kind === 'text' || kind === 'code' || kind === 'json' || kind === 'csv') && excerpt != null}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- highlight.js output: escaped source + <span class> only -->
      <pre
        class="hljs h-full overflow-hidden bg-surface px-2.5 py-2 font-mono text-[10.5px] leading-snug text-text">{@html highlightCode(
          excerpt,
          info.language,
        )}</pre>
    {:else}
      <span class="grid size-full place-items-center text-muted">
        <span class="flex flex-col items-center gap-1">
          <Icon size={28} strokeWidth={1.5} />
          {#if failed}<span class="text-[11px]">Preview unavailable</span>{/if}
        </span>
      </span>
    {/if}
    {#if kind === 'markdown' || kind === 'html' || kind === 'text' || kind === 'code' || kind === 'json' || kind === 'csv'}
      <span
        class="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-surface to-transparent"
      ></span>
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
    <Icon size={14} class="shrink-0 text-muted" aria-hidden="true" />
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

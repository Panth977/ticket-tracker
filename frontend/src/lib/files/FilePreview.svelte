<!--
  A file's PREVIEW, chosen by its kind (agents.html §I) — the body of a ticket
  FileCard and of a memory folder tile (memory.html §F):
    image     thumbnail            video   poster frame + duration
    markdown  rendered first lines html    live scaled-down page (sandboxed)
    pdf       first page           text / code / json / csv  first lines, highlighted
    other     the file's own icon (fileIcons.ts)
  Loads only once `shown` (the caller watches the viewport). Fills its box.
-->
<script lang="ts">
  /* eslint-disable svelte/no-at-html-tags -- highlightCode() escapes its input */
  import { Play } from 'lucide-svelte';
  import { HTML_SANDBOX, parseMemoryRefPath } from '@tm/shared';
  import { Markdown, highlightCode, markdownExcerpt } from '$lib/editor';
  import {
    CARD_HTML_BYTES,
    CARD_NEEDS_TEXT,
    CARD_TEXT_BYTES,
    firstLines,
    formatDuration,
    infoOf,
    prettyJson,
  } from './kinds';
  import { fileIcon } from './fileIcons';
  import { fileText, fileUrl } from './source';
  import type { ViewerFile } from './types';

  interface Props {
    file: ViewerFile;
    /** On (or near) screen: load now. */
    shown: boolean;
    disabled?: boolean;
    iconSize?: number;
    /** Bound out: the file's URL (audio players, memory 'gone' checks). */
    url?: string | null;
    /** Bound out: the text read for the excerpt (a Markdown card's title). */
    text?: string | null;
    /** Bound out: a memory reference that no longer resolves. */
    gone?: boolean;
  }
  let {
    file,
    shown,
    disabled = false,
    iconSize = 28,
    url = $bindable(null),
    text = $bindable(null),
    gone = $bindable(false),
  }: Props = $props();

  const info = $derived(infoOf(file));
  const kind = $derived(info.kind);
  const fi = $derived(fileIcon(file));
  let thumb = $state<string | null>(null);
  let failed = $state(false);
  let duration = $state<number | null>(null);
  /**
   * memory.html §E: a memory file is a REFERENCE — the door resolves it to the
   * node's current version. When it no longer can (the file was deleted, or
   * the memory is no longer shared with this board) the card says so.
   */
  const fromMemory = $derived(!!file.memory || !!parseMemoryRefPath(file.path));

  $effect(() => {
    if (!shown || disabled) return;
    const f = file;
    const k = kind;
    let alive = true;
    if (k === 'image' || k === 'video' || k === 'audio' || k === 'pdf' || fromMemory) {
      void fileUrl(f.path).then((u) => {
        if (!alive) return;
        url = u;
        if (fromMemory) gone = !u;
      });
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
</script>

{#if gone}
  <span
    class="grid size-full place-items-center px-3 text-center text-xs text-muted"
    data-memory-gone
  >
    No longer in memory
  </span>
{:else if kind === 'image' && (thumb || url)}
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
      <fi.icon size={iconSize} strokeWidth={1.5} class={fi.tone} />
      {#if failed}<span class="text-[11px]">Preview unavailable</span>{/if}
    </span>
  </span>
{/if}
{#if kind === 'markdown' || kind === 'html' || kind === 'text' || kind === 'code' || kind === 'json' || kind === 'csv'}
  <span
    class="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-surface to-transparent"
  ></span>
{/if}

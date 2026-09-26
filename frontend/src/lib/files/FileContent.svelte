<!--
  The viewer body for one file, by kind (agents.html §I):
    image     lightbox: zoom and pan          video / audio   native player
    markdown  rendered, TOC, Source toggle    html   sandboxed iframe (srcdoc)
    pdf       the browser's PDF viewer        csv    a table
    text / code / json   highlighted, line numbers
    other     icon + size + Download
  Shared by the overlay and the /f/… page.
-->
<script lang="ts">
  import { Download, Loader2 } from 'lucide-svelte';
  import { formatBytes } from '@tm/shared';
  import { Button } from '$lib/ui';
  import { KIND_ICON, KIND_LABEL, VIEWER_TEXT_BYTES, infoOf, prettyJson } from './kinds';
  import { downloadFile, fileText, fileUrl, type FileTextResult } from './source';
  import type { ViewerFile } from './types';
  import CodeView from './CodeView.svelte';
  import CsvTable from './CsvTable.svelte';
  import HtmlFrame from './HtmlFrame.svelte';
  import ImageZoom from './ImageZoom.svelte';
  import MarkdownDoc from './MarkdownDoc.svelte';

  interface Props {
    file: ViewerFile;
    ticketHref?: (key: string) => string;
  }
  let { file, ticketHref }: Props = $props();

  const info = $derived(infoOf(file));
  const kind = $derived(info.kind);
  const Icon = $derived(KIND_ICON[kind]);

  let url = $state<string | null>(null);
  let text = $state<FileTextResult | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let zoom = $state<ImageZoom | null>(null);
  let jsonPretty = $state(true);

  $effect(() => {
    const f = file;
    const k = kind;
    let alive = true;
    url = null;
    text = null;
    error = null;
    loading = true;
    if (info.textual) {
      fileText(f, VIEWER_TEXT_BYTES)
        .then((r) => alive && ((text = r), (loading = false)))
        .catch(() => alive && ((error = 'Could not load this file.'), (loading = false)));
    } else if (k !== 'other') {
      void fileUrl(f.path).then((u) => {
        if (!alive) return;
        url = u;
        loading = false;
        if (!u) error = 'Could not load this file.';
      });
    } else loading = false;
    return () => {
      alive = false;
    };
  });

  /** Keys for the image zoom (+ − 0); the viewer calls this before its own keys. */
  export function key(e: KeyboardEvent): boolean {
    return kind === 'image' && !!zoom?.key(e);
  }
</script>

<div class="flex size-full min-h-0 flex-col" data-kind={kind}>
  {#if loading}
    <div class="grid flex-1 place-items-center text-muted">
      <Loader2 size={22} class="animate-spin" aria-label="Loading" />
    </div>
  {:else if error}
    <div class="grid flex-1 place-items-center p-6 text-center text-sm text-muted">
      <div class="flex flex-col items-center gap-3">
        <Icon size={36} strokeWidth={1.25} />
        <p>{error}</p>
        <Button size="sm" icon={Download} onclick={() => downloadFile(file)}>Download</Button>
      </div>
    </div>
  {:else if kind === 'image' && url}
    <ImageZoom bind:this={zoom} src={url} alt={file.name} />
  {:else if kind === 'video' && url}
    <div class="grid min-h-0 flex-1 place-items-center bg-black">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={url} controls autoplay playsinline class="max-h-full max-w-full"></video>
    </div>
  {:else if kind === 'audio' && url}
    <div class="grid flex-1 place-items-center p-6">
      <div class="flex w-full max-w-md flex-col items-center gap-4">
        <span class="grid size-24 place-items-center rounded-2xl bg-accent-soft text-accent"
          ><Icon size={40} strokeWidth={1.5} /></span
        >
        <p class="max-w-full truncate text-sm font-medium">{file.name}</p>
        <audio src={url} controls autoplay class="w-full"></audio>
      </div>
    </div>
  {:else if kind === 'pdf' && url}
    <iframe src={url} title={file.name} class="min-h-0 w-full flex-1 border-0 bg-white"></iframe>
  {:else if kind === 'html' && text}
    <HtmlFrame html={text.text} title={file.name} class="min-h-0 w-full flex-1" />
  {:else if kind === 'markdown' && text}
    <div class="min-h-0 flex-1 bg-surface"><MarkdownDoc text={text.text} {ticketHref} /></div>
  {:else if kind === 'csv' && text}
    <div class="min-h-0 flex-1 overflow-auto bg-surface">
      <CsvTable text={text.text} name={file.name} truncatedFile={text.truncated} />
    </div>
  {:else if (kind === 'json' || kind === 'code' || kind === 'text') && text}
    {#if kind === 'json'}
      <div class="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-xs">
        <label class="flex items-center gap-1.5 text-muted"
          ><input type="checkbox" bind:checked={jsonPretty} /> Pretty-print</label
        >
      </div>
    {/if}
    <div class="min-h-0 flex-1 overflow-auto bg-surface">
      <CodeView
        text={kind === 'json' && jsonPretty ? prettyJson(text.text) : text.text}
        language={info.language}
      />
      {#if text.truncated}<p class="px-3 py-2 text-xs text-muted">
          Showing the first {formatBytes(VIEWER_TEXT_BYTES)} — download the file for the rest.
        </p>{/if}
    </div>
  {:else}
    <div class="grid flex-1 place-items-center p-6">
      <div class="flex flex-col items-center gap-3 text-center">
        <span class="grid size-20 place-items-center rounded-2xl bg-surface-2 text-muted"
          ><Icon size={36} strokeWidth={1.25} /></span
        >
        <p class="max-w-sm truncate text-sm font-medium">{file.name}</p>
        <p class="text-xs text-muted">
          {KIND_LABEL[kind]} · {formatBytes(file.size)} · no preview for this type
        </p>
        <Button size="sm" variant="primary" icon={Download} onclick={() => downloadFile(file)}
          >Download</Button
        >
      </div>
    </div>
  {/if}
</div>

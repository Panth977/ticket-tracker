<!--
  The in-app viewer (agents.html §I): the file, the files before and after it
  on this ticket (← / →), Download, Open in new tab, and — from the thread —
  a jump to the message it came in.
    layout 'overlay'  fixed over the app (Esc closes)
    layout 'page'     fills its container (/f/{boardKey}/{ticketKey}/{fileId})
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- file URLs are external */
  import { onMount, tick } from 'svelte';
  import {
    ChevronLeft,
    ChevronRight,
    Download,
    ExternalLink,
    MessageSquare,
    X,
  } from 'lucide-svelte';
  import { formatBytes } from '@tm/shared';
  import { toast } from '$lib/ui';
  import FileContent from './FileContent.svelte';
  import { KIND_ICON, kindOf } from './kinds';
  import { downloadFile } from './source';
  import type { ViewerFile } from './types';

  interface Props {
    files: readonly ViewerFile[];
    /** The shown file's id. */
    current: string;
    layout?: 'overlay' | 'page';
    /** Move to another file (default: just show it). The page navigates instead. */
    onselect?: (file: ViewerFile) => void;
    onclose?: () => void;
    /** The /f/… address for 'Open in new tab' (null hides it). */
    hrefFor?: (file: ViewerFile) => string | null;
    /** 'Show in thread' for files that came in a message. */
    onjump?: (file: ViewerFile) => void;
    /** 'Priya · 2 h ago' under the name. */
    describe?: (file: ViewerFile) => string | null;
    ticketHref?: (key: string) => string;
  }
  let {
    files,
    current = $bindable(),
    layout = 'overlay',
    onselect,
    onclose,
    hrefFor,
    onjump,
    describe,
    ticketHref,
  }: Props = $props();

  const index = $derived(files.findIndex((f) => f.id === current));
  const file = $derived(index >= 0 ? files[index]! : null);
  const prev = $derived(index > 0 ? files[index - 1]! : null);
  const next = $derived(index >= 0 && index < files.length - 1 ? files[index + 1]! : null);
  const href = $derived(file && hrefFor ? hrefFor(file) : null);
  const Icon = $derived(file ? KIND_ICON[kindOf(file)] : null);
  /** Big side arrows only over media; documents keep their edges (TOC, scrollbars). */
  const sideArrows = $derived(!!file && ['image', 'video'].includes(kindOf(file)));

  let content = $state<FileContent | null>(null);
  let dialog = $state<HTMLElement | null>(null);

  function select(f: ViewerFile | null) {
    if (!f) return;
    if (onselect) onselect(f);
    else current = f.id;
  }
  async function download() {
    if (file && !(await downloadFile(file))) toast.error('Could not download the file');
  }

  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (
      el &&
      (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) &&
      e.key !== 'Escape'
    )
      return;
    // Media elements keep their own arrow keys (seek / volume).
    if (el && /^(VIDEO|AUDIO)$/.test(el.tagName) && e.key !== 'Escape') return;
    let handled = true;
    if (e.key === 'Escape' && layout === 'overlay') onclose?.();
    else if (e.key === 'ArrowLeft' && prev) select(prev);
    else if (e.key === 'ArrowRight' && next) select(next);
    else handled = !!content?.key(e);
    if (handled) {
      e.preventDefault();
      // The drawer under the overlay must not also react (Esc would close it).
      e.stopPropagation();
    }
  }

  let before: Element | null = null;
  onMount(() => {
    before = document.activeElement;
    void tick().then(() => dialog?.focus());
    // Capture phase: we see keys before the drawer / global shortcuts do.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (layout === 'overlay' && before instanceof HTMLElement) before.focus();
    };
  });
</script>

<div
  bind:this={dialog}
  class="{layout === 'overlay'
    ? 'fixed inset-0 z-[80] bg-bg/95 backdrop-blur-sm'
    : 'relative h-full min-h-0 w-full bg-bg'} flex flex-col outline-none"
  role={layout === 'overlay' ? 'dialog' : 'region'}
  aria-modal={layout === 'overlay' ? 'true' : undefined}
  aria-label={file ? `Viewing ${file.name}` : 'File viewer'}
  tabindex="-1"
>
  <header
    class="flex min-h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-1.5"
  >
    {#if Icon}<Icon size={16} class="shrink-0 text-muted" aria-hidden="true" />{/if}
    <div class="min-w-0 flex-1">
      <h2 class="truncate text-sm font-semibold" title={file?.name}>
        {file?.name ?? 'File not found'}
      </h2>
      {#if file}
        <p class="truncate text-xs text-muted">
          {formatBytes(file.size)}{#if describe?.(file)}
            · {describe(file)}{/if}{#if files.length > 1}
            · {index + 1} of {files.length}{/if}
        </p>
      {/if}
    </div>
    {#if files.length > 1}
      <button
        type="button"
        class="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
        aria-label="Previous file"
        title="Previous (←)"
        disabled={!prev}
        onclick={() => select(prev)}><ChevronLeft size={18} /></button
      >
      <button
        type="button"
        class="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
        aria-label="Next file"
        title="Next (→)"
        disabled={!next}
        onclick={() => select(next)}><ChevronRight size={18} /></button
      >
      <span class="mx-1 h-5 w-px bg-line" aria-hidden="true"></span>
    {/if}
    {#if file && onjump && file.messageId}
      <button
        type="button"
        class="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
        title="Show the message"
        onclick={() => onjump(file)}
        ><MessageSquare size={15} /><span class="hidden sm:inline">Message</span></button
      >
    {/if}
    {#if file}
      <button
        type="button"
        class="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
        title="Download"
        onclick={download}
        ><Download size={15} /><span class="hidden sm:inline">Download</span></button
      >
    {/if}
    {#if href}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an app path built by fileViewerPath; the SPA has no base path -->
      <a
        {href}
        target="_blank"
        rel="noopener"
        class="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
        title="Open in new tab"
        ><ExternalLink size={15} /><span class="hidden sm:inline">New tab</span></a
      >
    {/if}
    {#if onclose}
      <button
        type="button"
        class="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-text"
        aria-label="Close"
        title="Close (Esc)"
        onclick={onclose}><X size={18} /></button
      >
    {/if}
  </header>

  <div class="relative flex min-h-0 flex-1 flex-col">
    {#if file}
      {#key file.id}
        <FileContent bind:this={content} {file} {ticketHref} />
      {/key}
      {#if prev && sideArrows}
        <button
          type="button"
          class="absolute top-1/2 left-3 z-[2] hidden -translate-y-1/2 rounded-full border border-line bg-surface/90 p-2 text-muted shadow-pop hover:text-text md:block"
          aria-label="Previous file"
          onclick={() => select(prev)}><ChevronLeft size={20} /></button
        >
      {/if}
      {#if next && sideArrows}
        <button
          type="button"
          class="absolute top-1/2 right-3 z-[2] hidden -translate-y-1/2 rounded-full border border-line bg-surface/90 p-2 text-muted shadow-pop hover:text-text md:block"
          aria-label="Next file"
          onclick={() => select(next)}><ChevronRight size={20} /></button
        >
      {/if}
    {:else}
      <div class="grid flex-1 place-items-center text-sm text-muted">
        This file is not on the ticket any more.
      </div>
    {/if}
  </div>
</div>

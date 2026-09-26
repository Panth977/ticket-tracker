<!--
  A Markdown document in the viewer (agents.html §I): rendered like a message,
  a table of contents for long documents, and a Source toggle.
-->
<script lang="ts">
  import { Code, Eye, ListTree } from 'lucide-svelte';
  import { Markdown, type MarkdownHeading } from '$lib/editor';
  import CodeView from './CodeView.svelte';

  interface Props {
    text: string;
    ticketHref?: (key: string) => string;
  }
  let { text, ticketHref }: Props = $props();

  let mode = $state<'preview' | 'source'>('preview');
  let headings = $state<MarkdownHeading[]>([]);
  let root = $state<HTMLElement | null>(null);
  let tocOpen = $state(true);
  /** A TOC is worth it from 3 headings on. */
  const toc = $derived(headings.filter((h) => h.level <= 3 && h.id));
  const showToc = $derived(mode === 'preview' && toc.length >= 3);
  const minLevel = $derived(Math.min(...toc.map((h) => h.level)));

  function go(id: string) {
    root
      ?.querySelector(`#${CSS.escape(id)}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <div
    class="flex items-center gap-1 border-b border-line px-3 py-1.5"
    role="toolbar"
    aria-label="Markdown view"
  >
    <div class="flex rounded-md border border-line p-0.5" role="radiogroup" aria-label="Show">
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'preview'}
        onclick={() => (mode = 'preview')}
        class="flex items-center gap-1 rounded px-2 py-0.5 text-xs {mode === 'preview'
          ? 'bg-surface-2 text-text'
          : 'text-muted hover:text-text'}"
      >
        <Eye size={13} /> Preview
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'source'}
        onclick={() => (mode = 'source')}
        class="flex items-center gap-1 rounded px-2 py-0.5 text-xs {mode === 'source'
          ? 'bg-surface-2 text-text'
          : 'text-muted hover:text-text'}"
      >
        <Code size={13} /> Source
      </button>
    </div>
    <span class="flex-1"></span>
    {#if showToc}
      <button
        type="button"
        class="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text"
        aria-pressed={tocOpen}
        onclick={() => (tocOpen = !tocOpen)}><ListTree size={13} /> Contents</button
      >
    {/if}
  </div>
  <div class="flex min-h-0 flex-1">
    {#if showToc && tocOpen}
      <nav
        class="hidden w-56 shrink-0 overflow-y-auto border-r border-line px-2 py-3 text-sm md:block"
        aria-label="Table of contents"
      >
        <ul class="flex flex-col gap-0.5">
          {#each toc as h (h.id)}
            <li>
              <button
                type="button"
                class="w-full truncate rounded px-2 py-0.5 text-left text-muted hover:bg-surface-2 hover:text-text"
                style="padding-left:{0.5 + (h.level - minLevel) * 0.75}rem"
                title={h.text}
                onclick={() => go(h.id)}>{h.text}</button
              >
            </li>
          {/each}
        </ul>
      </nav>
    {/if}
    <div class="min-w-0 flex-1 overflow-y-auto">
      {#if mode === 'preview'}
        <article class="mx-auto max-w-3xl px-6 py-6">
          <Markdown
            source={text}
            {ticketHref}
            anchors
            bind:headings
            bind:el={root}
            class="text-[15px]"
          />
        </article>
      {:else}
        <CodeView {text} language="markdown" />
      {/if}
    </div>
  </div>
</div>

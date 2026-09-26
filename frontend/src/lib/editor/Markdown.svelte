<!--
  GitHub-flavoured Markdown, sanitised (markdown.ts):
    <Markdown source={message.markdown} ticketHref={…} breaks />
  The HTML is DOMPurify-cleaned before it reaches {@html}; code blocks get a
  working Copy button through the delegated copyCode action.
-->
<script lang="ts">
  import { renderMarkdown, type MarkdownHeading } from './markdown';
  import { copyCode } from './copyCode';
  import './prose.css';
  import './markdown.css';

  interface Props {
    source: string;
    ticketHref?: (key: string) => string;
    /** Headings get ids (for a TOC). */
    anchors?: boolean;
    /** Single newlines → <br> (comments), off for documents. */
    breaks?: boolean;
    class?: string;
    /** The rendered headings, for a table of contents. */
    headings?: MarkdownHeading[];
    /** The rendered root, for scrolling to headings. */
    el?: HTMLElement | null;
  }
  let {
    source,
    ticketHref,
    anchors = false,
    breaks = false,
    class: cls = '',
    // eslint-disable-next-line no-useless-assignment -- $bindable()'s argument is the fallback when the parent does not bind, not a first value
    headings = $bindable([]),
    el = $bindable(null),
  }: Props = $props();

  const rendered = $derived(renderMarkdown(source, { ticketHref, anchors, breaks }));
  $effect(() => {
    headings = rendered.headings;
  });
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised by renderMarkdown (DOMPurify allow-list) -->
<div bind:this={el} class="tm-prose tm-md {cls}" use:copyCode>{@html rendered.html}</div>

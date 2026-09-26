<!-- Text / code with line numbers and syntax highlighting: <CodeView text={…} language="typescript" /> -->
<script lang="ts">
  import { highlightCode } from '$lib/editor';
  import '$lib/editor/markdown.css';

  let {
    text,
    language = null,
    class: cls = '',
  }: { text: string; language?: string | null; class?: string } = $props();
  const html = $derived(highlightCode(text, language));
  const lines = $derived(
    text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length,
  );
</script>

<div class="flex min-w-0 font-mono text-[12.5px] leading-[1.55] {cls}">
  <pre
    class="shrink-0 border-r border-line bg-surface-2 px-2.5 py-3 text-right text-subtle select-none"
    aria-hidden="true">{Array.from({ length: lines }, (_, i) => i + 1).join('\n')}</pre>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- highlight.js output: escaped source + <span class> only -->
  <pre class="hljs min-w-0 flex-1 overflow-x-auto px-3 py-3 text-text"><code>{@html html}</code
    ></pre>
</div>

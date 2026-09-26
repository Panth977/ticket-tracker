<!--
  A highlighted code block with a Copy button — the rich-text codeBlock node
  (human messages) renders the same way as a Markdown fence.
-->
<script lang="ts">
  import { highlightCode } from './highlight';
  import { copyCode } from './copyCode';

  let { code, language = null }: { code: string; language?: string | null } = $props();
  const html = $derived(highlightCode(code, language));
</script>

<div class="md-code" use:copyCode>
  <button type="button" class="md-copy" data-copy="">Copy</button>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- highlight.js output: escaped source + <span class> only -->
  <pre><code class="hljs">{@html html}</code></pre>
</div>

<!--
  An HTML document, run in a sandbox (agents.html §I):
    sandbox="allow-scripts allow-popups allow-forms" — NEVER allow-same-origin
    loaded from srcdoc, so the frame is an opaque origin: the document's own
    scripts run, but it can never read the app, its storage, cookies or the
    Firebase session, and it can't navigate the app.
-->
<script lang="ts">
  import { HTML_SANDBOX } from '@tm/shared';

  let { html, title, class: cls = '' }: { html: string; title: string; class?: string } = $props();
</script>

<iframe
  {title}
  sandbox={HTML_SANDBOX}
  srcdoc={html}
  referrerpolicy="no-referrer"
  class="block border-0 bg-white {cls}"
></iframe>

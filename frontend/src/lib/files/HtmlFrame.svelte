<!--
  An HTML document, run in a sandbox (agents.html §I):
    sandbox="allow-scripts allow-popups allow-forms allow-modals allow-downloads" — NEVER allow-same-origin
    loaded from srcdoc, so the frame is an opaque origin: the document's own
    scripts run, but it can never read the app, its storage, cookies or the
    Firebase session, and it can't navigate the app. Storage and cookies get
    in-memory stand-ins (htmlForFrame), since the real ones throw there.
-->
<script lang="ts">
  import { HTML_SANDBOX, htmlForFrame } from '@tm/shared';

  let { html, title, class: cls = '' }: { html: string; title: string; class?: string } = $props();
</script>

<iframe
  {title}
  sandbox={HTML_SANDBOX}
  srcdoc={htmlForFrame(html)}
  allow="clipboard-write"
  referrerpolicy="no-referrer"
  class="block border-0 bg-white {cls}"
></iframe>

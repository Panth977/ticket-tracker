<!--
  Read-only rich text: <RichView doc={message.body.doc} ticketHref={(key) => …} />
-->
<script lang="ts">
  import type { RichTextDoc } from '@tm/shared';
  import RichNode from './RichNode.svelte';
  import './prose.css';
  import './markdown.css';

  interface Props {
    doc: RichTextDoc | null | undefined;
    ticketHref?: (key: string, ticketId: string) => string;
    class?: string;
  }
  let { doc, ticketHref, class: cls = '' }: Props = $props();
</script>

<div class="tm-prose {cls}">
  {#each doc?.content ?? [] as n, i (i)}<RichNode node={n} {ticketHref} />{/each}
</div>

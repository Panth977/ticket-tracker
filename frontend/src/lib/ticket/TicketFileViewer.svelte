<!--
  The drawer's file viewer host: renders the overlay when a card anywhere in
  the drawer calls fileViewer.open(). Prev / next walk every live file on the
  ticket, oldest first (agents.html §I).
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { FileViewer, fileViewer, viewerList, type ViewerFile } from '$lib/files';
  import { getTicketCtx } from './context';
  import { ticketFiles } from './data';
  import { fileDescriber, fileHref } from './files';

  const t = getTicketCtx();
  const files = ticketFiles(t.boardId, t.ticketId);
  const live = $derived($files.data.filter((f) => !f.deletedAt) as ViewerFile[]);
  const list = $derived(viewerList(fileViewer.current, live, fileViewer.siblings));

  onDestroy(() => fileViewer.close());
</script>

{#if fileViewer.current}
  <FileViewer
    files={list}
    bind:current={fileViewer.current}
    layout="overlay"
    onclose={() => fileViewer.close()}
    hrefFor={fileHref(t)}
    describe={fileDescriber(t)}
    ticketHref={t.ticketHref}
    onjump={(f) => {
      fileViewer.close();
      if (f.messageId) t.showMessage(f.messageId);
    }}
  />
{/if}

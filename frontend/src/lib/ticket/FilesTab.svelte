<!--
  Attachments (the right pane's middle section): every file on the ticket
  (…/files/), newest first, as the same preview cards the thread shows
  (agents.html §H). A card opens the in-app viewer; 'Show message' jumps to
  where it was posted.
-->
<script lang="ts">
  import { MessageSquare, Paperclip } from 'lucide-svelte';
  import { EmptyState, Skeleton } from '$lib/ui';
  import { FileGrid, fileViewer, type ViewerFile } from '$lib/files';
  import { getTicketCtx } from './context';
  import { ticketFiles } from './data';
  import { fileHref } from './files';

  const t = getTicketCtx();
  const files = $derived(ticketFiles(t.boardId, t.ticketId));
  const live = $derived($files.data.filter((f) => !f.deletedAt) as ViewerFile[]);
</script>

<div>
  {#if $files.loading}
    <div class="grid grid-cols-2 gap-2" aria-busy="true" aria-label="Loading files">
      {#each [0, 1] as i (i)}<Skeleton height="5.5rem" class="rounded-lg" />{/each}
    </div>
  {:else if !live.length}
    <EmptyState
      icon={Paperclip}
      title="No files yet"
      description="Paste or drop files into a reply to attach them."
    />
  {:else}
    <FileGrid files={live} min={140} onopen={(f) => fileViewer.open(f, live)} hrefFor={fileHref(t)}>
      {#snippet extra(f)}
        {#if f.messageId}
          <button
            type="button"
            class="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
            aria-label="Show the message"
            title="Show the message"
            onclick={() => t.showMessage(f.messageId!)}><MessageSquare size={14} /></button
          >
        {/if}
      {/snippet}
    </FileGrid>
  {/if}
</div>

<!--
  /f/{boardKey}/{ticketKey}/{fileId} — one file of a ticket in the viewer, as
  a full page (agents.html §I): an HTML report or a Markdown plan gets a whole
  window and its own address. ← / → walk the ticket's files (each its own URL).

  keys/{KEY} resolves the ticket, and a typo'd board key in the address is
  rewritten to the ticket's own board and key. The file
  is read with a short-lived download URL / SDK read, which the Storage rules
  only grant to people on the board.
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- paths built by fileViewerPath / routes; the SPA has no base path */
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { ArrowLeft, Loader2 } from 'lucide-svelte';
  import { fileViewerPath } from '@tm/shared';
  import { EmptyState } from '$lib/ui';
  import { routes } from '$lib/layout/routes';
  import { FileViewer, type ViewerFile } from '$lib/files';
  import { boardDoc, boardMembers, keyIndex, ticketDoc, ticketFiles } from '$lib/ticket/data';
  import { noteBoardMembers } from '$lib/people';
  import { formatWhen } from '$lib/ticket/time';
  import { auth } from '$lib/firebase/auth.svelte';

  const ticketKey = $derived((page.params.ticketKey ?? '').toUpperCase());
  const fileId = $derived(page.params.fileId ?? '');

  const idx = $derived(keyIndex(ticketKey));
  const live = $derived($idx.data && !$idx.data.deleted ? $idx.data : null);
  const boardId = $derived(live?.boardId ?? null);
  const ticketId = $derived(live?.ticketId ?? null);
  const bd = $derived(boardDoc(boardId));
  const tk = $derived(ticketDoc(boardId, ticketId));
  const mem = $derived(boardMembers(boardId));
  const fl = $derived(ticketFiles(boardId, ticketId));

  /** Oldest first, so → is 'the next file posted'. */
  const files = $derived(
    ($fl.data.filter((f) => !f.deletedAt) as ViewerFile[])
      .slice()
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
  );
  const file = $derived(files.find((f) => f.id === fileId) ?? null);
  const board = $derived($bd.data);
  const ticket = $derived($tk.data);
  const tz = $derived(auth.profile?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const loading = $derived(
    $idx.loading || (!!boardId && ($bd.loading || $tk.loading || $fl.loading)),
  );

  $effect(() => {
    if (boardId && $mem.data.length) noteBoardMembers(boardId, $mem.data);
  });

  const href = (f: ViewerFile) =>
    board && ticket ? fileViewerPath(board.key, ticket.key, f.id) : null;

  // The canonical address: the ticket's own key and board key (a typo'd board key is rewritten).
  $effect(() => {
    if (!board || !ticket || !fileId) return;
    if (board.key !== page.params.boardKey || ticket.key !== page.params.ticketKey) {
      void goto(fileViewerPath(board.key, ticket.key, fileId) + page.url.search, {
        replaceState: true,
      });
    }
  });

  function describe(f: ViewerFile): string | null {
    const who = f.uploadedBy ? ($mem.data.find((m) => m.uid === f.uploadedBy)?.name ?? null) : null;
    const when = f.createdAt ? formatWhen(f.createdAt, tz) : null;
    return [who, when].filter(Boolean).join(' · ') || null;
  }
  const ticketHref = (k: string) => routes.ticket(k);
</script>

<svelte:head
  ><title>{file?.name ?? 'File'} · {ticket?.key ?? ticketKey} · TaskManager</title></svelte:head
>

<div class="flex h-dvh flex-col bg-bg text-text">
  <nav
    class="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 text-sm"
    aria-label="Breadcrumb"
  >
    <a
      href={routes.ticket(ticket?.key ?? ticketKey)}
      class="flex items-center gap-1 text-muted hover:text-text"
    >
      <ArrowLeft size={15} /> <span class="font-mono">{ticket?.key ?? ticketKey}</span>
    </a>
    {#if ticket}<span class="truncate text-muted">— {ticket.title}</span>{/if}
    <span class="flex-1"></span>
    {#if board}<a href={routes.board(board.key)} class="truncate text-xs text-muted hover:text-text"
        >{board.name}</a
      >{/if}
  </nav>

  <div class="min-h-0 flex-1">
    {#if loading}
      <div class="grid h-full place-items-center text-muted">
        <Loader2 size={22} class="animate-spin" aria-label="Loading" />
      </div>
    {:else if !$idx.exists && !$idx.error}
      <EmptyState
        title="No ticket {ticketKey}"
        description="Check the address — or it may never have existed."
      />
    {:else if $idx.data?.deleted}
      <EmptyState title="{ticketKey} was deleted" description="Its files were removed with it." />
    {:else if $idx.error || $bd.error || $tk.error || $fl.error}
      <EmptyState
        title="You can't see this file"
        description="It's on a board you're not a member of. Ask someone on that board to invite you."
      />
    {:else if !file}
      <EmptyState
        title="File not found"
        description="It may have been removed from {ticket?.key ?? ticketKey}."
      />
    {:else}
      <FileViewer
        {files}
        current={file.id}
        layout="page"
        onselect={(f) => {
          const to = href(f);
          if (to) void goto(to);
        }}
        {describe}
        {ticketHref}
        onjump={(f) =>
          f.messageId &&
          goto(`${routes.ticket(ticket?.key ?? ticketKey)}?m=${encodeURIComponent(f.messageId)}`)}
      />
    {/if}
  </div>
</div>

<!--
  A ticket referenced by id (links, referencedBy, relation fields): 'ENG-44 Fix
  the callback' linking to it, or — when it lives on a board I can't read —
  a muted 'hidden ticket' (the caller may count those instead).
  <TicketChip ticketId={id} onremove={…} />
-->
<script lang="ts">
  // Ticket links come from ctx.ticketHref (lib/layout/routes); other hrefs are external. The SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { EyeOff, X } from 'lucide-svelte';
  import { myBoards } from '$lib/stores';
  import { auth } from '$lib/firebase/auth.svelte';
  import { getTicketCtx } from './context';
  import { locatedTicket, type Located } from './data';

  interface Props {
    ticketId: string;
    /** Prefix, e.g. 'blocks'. */
    label?: string;
    onremove?: () => void;
    /** Report visibility to the parent (for 'N tickets you can't see'). */
    onstatus?: (status: Located['status']) => void;
    /** Render nothing when hidden (the parent counts it). */
    hideHidden?: boolean;
  }
  let { ticketId, label, onremove, onstatus, hideHidden = false }: Props = $props();

  const t = getTicketCtx();
  const boards = $derived(myBoards(auth.uid));
  const boardIds = $derived([
    t.boardId,
    ...$boards.data.map((b) => b.id).filter((id) => id !== t.boardId),
  ]);
  // Wait for my board list so the lookup does not settle on 'hidden' too early.
  const loc = $derived($boards.loading ? null : locatedTicket(ticketId, boardIds));
  const state = $derived<Located>(loc ? $loc! : { status: 'loading' });
  $effect(() => onstatus?.(state.status));

  const done = $derived(
    state.status === 'found' && ['done', 'cancelled'].includes(state.ticket.stageCategory),
  );
</script>

{#if state.status === 'found'}
  <span class="group inline-flex max-w-full min-w-0 items-center gap-1.5 text-sm">
    {#if label}<span class="shrink-0 text-xs text-muted">{label}</span>{/if}
    <a
      href={t.ticketHref(state.ticket.key)}
      class="inline-flex min-w-0 items-center gap-1.5 rounded px-1 hover:bg-surface-2"
    >
      <span class="shrink-0 font-mono text-xs {done ? 'text-subtle line-through' : 'text-muted'}"
        >{state.ticket.key}</span
      >
      <span class="truncate {done ? 'text-muted' : ''}">{state.ticket.title}</span>
    </a>
    {#if onremove}
      <button
        type="button"
        onclick={onremove}
        aria-label="Remove {state.ticket.key}"
        class="shrink-0 rounded p-0.5 text-subtle opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"
        ><X size={12} /></button
      >
    {/if}
  </span>
{:else if state.status === 'hidden' && !hideHidden}
  <span class="group inline-flex items-center gap-1.5 text-sm text-subtle">
    {#if label}<span class="text-xs">{label}</span>{/if}
    <EyeOff size={12} aria-hidden="true" /> a ticket you can't see
    {#if onremove}
      <button
        type="button"
        onclick={onremove}
        aria-label="Remove link"
        class="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"
        ><X size={12} /></button
      >
    {/if}
  </span>
{:else if state.status === 'loading'}
  <span class="inline-block h-4 w-24 animate-pulse rounded bg-surface-3" aria-hidden="true"></span>
{/if}

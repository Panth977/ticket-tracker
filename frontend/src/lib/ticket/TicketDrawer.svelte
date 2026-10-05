<!--
  The Ticket drawer (app.json › Ticket drawer). Props are FINAL for every
  caller (board ?ticket=, inbox, my work, /t/KEY):
    <TicketDrawer ticketKey="ENG-42" onClose={…} />
  Optional: layout="page" (the /t/KEY screen: full width, no resize).

  '#ENG-42' resolves through keys/{KEY}, which is how a link, an e-mail or a
  webhook payload finds the ticket without naming its board.

  Layout (agents.html § K › The ticket view: two panes, no tabs): a fixed
  header, then two panes that each scroll on their own —
    left   title + description (fixed; long ones collapse), the thread
           (scrolls), the composer (pinned to the bottom, even when empty)
    right  Details (fields, related) · Attachments · Activity, collapsible
  On a narrow drawer / phone the right pane hides behind a Details button.
  The drawer slides in from the right over a fading backdrop.

  Opening a ticket marks it read: the old read pointer is kept (readSince in
  the ticket context) for the 'New messages' / 'New' dividers.
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { doc as fsDoc, setDoc } from 'firebase/firestore';
  import {
    Archive,
    ArrowLeft,
    Bell,
    BellOff,
    Copy,
    Maximize2,
    MoreHorizontal,
    PanelRight,
    RotateCcw,
    Trash2,
    TriangleAlert,
    X,
  } from 'lucide-svelte';
  import { paths } from '@tm/shared';
  import { outbox } from '$lib/api';
  import { getDb } from '$lib/firebase/client';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { boardPref, inboxUnread } from '$lib/stores';
  import { Badge, Button, Dialog, EmptyState, IconButton, Menu, Skeleton, toast } from '$lib/ui';
  import type { MenuItem } from '$lib/ui';
  import PersonAvatar from './PersonAvatar.svelte';
  import { clock } from '$lib/notifications/stores';
  import { readTicketNotifications } from '$lib/notifications';
  import {
    boardDoc,
    boardMembers,
    keyIndex,
    myRead,
    questionMessages,
    ticketDoc,
    ticketFiles,
  } from './data';
  import { blockingQuestions, waitingBadgeLabel, waitingQuestions } from './question';
  import { ticketPerms } from './perms';
  import { withReadState } from './state';
  import { setTicketCtx } from './context';
  import { viewTicket, viewers as viewersOf } from './presence';
  import TicketTitle from './TicketTitle.svelte';
  import TicketDescription from './TicketDescription.svelte';
  import FieldPanel from './FieldPanel.svelte';
  import RelatedPanel from './RelatedPanel.svelte';
  import Thread from './Thread.svelte';
  import ActivityTab from './ActivityTab.svelte';
  import FilesTab from './FilesTab.svelte';
  import PaneSection from './PaneSection.svelte';
  import Tasklists from './Tasklists.svelte';
  import TicketFileViewer from './TicketFileViewer.svelte';
  import { noteBoardMembers } from '$lib/people';
  import TicketAgentHealth from '$lib/agents/TicketAgentHealth.svelte';
  import { aggCountersOf, ticketChips } from '$lib/aggregates/fields';

  interface Props {
    ticketKey: string;
    onClose: () => void;
    layout?: 'drawer' | 'page';
  }
  let { ticketKey, onClose, layout = 'drawer' }: Props = $props();

  const key = $derived(ticketKey.trim().toUpperCase());
  const idx = $derived(keyIndex(key));
  const boardId = $derived($idx.data && !$idx.data.deleted ? $idx.data.boardId : null);
  const ticketId = $derived($idx.data && !$idx.data.deleted ? $idx.data.ticketId : null);
  const tk = $derived(ticketDoc(boardId, ticketId));
  const bd = $derived(boardDoc(boardId));
  const mem = $derived(boardMembers(boardId));
  // A ticket still stored as the pre-phase-6 'cancelled' reads as archived.
  const ticket = $derived($tk.data ? withReadState($tk.data) : $tk.data);
  const board = $derived($bd.data);
  /** aggregates.html: the ticket's total on every active field that has entries. */
  const aggChips = $derived(board && ticket ? ticketChips(board, aggCountersOf(ticket)) : []);
  const me = $derived(auth.uid ?? '');
  const perms = $derived(ticketPerms(board, ticket, me));
  const tz = $derived(auth.profile?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  /** Rolls over every half-minute so an expiry locks a question while the drawer is open. */
  const tick = clock(30_000);

  // ——— where '#KEY' links go: stay in the board's drawer when we are in one.
  function ticketHref(k: string): string {
    if (layout === 'drawer' && page.url.searchParams.has('ticket')) {
      const u = new URL(page.url);
      u.searchParams.set('ticket', k);
      u.searchParams.delete('m');
      return u.pathname + u.search;
    }
    return routes.ticket(k);
  }

  let focusMsg = $state<string | null>(page.url.searchParams.get('m'));
  /** Narrow drawer / phone: the right pane is shown over the left one. */
  let details = $state(false);

  // ——— unread: remember my read pointer as it was, then mark the ticket read (agents.html § K › Unread)
  const read = $derived(myRead(me, ticketId));
  let since = $state<{ ticketId: string; at: number | null } | null>(null);
  const readSince = $derived(since && since.ticketId === ticketId ? since.at : undefined);
  $effect(() => {
    const r = $read;
    const id = ticketId;
    if (!id || !boardId || !me || !ticket || r.loading) return;
    untrack(() => {
      if (since?.ticketId === id) return;
      since = { ticketId: id, at: r.data?.readAt ?? null };
      const at = Math.max(Date.now(), ticket.lastMessageAt ?? 0);
      void setDoc(
        fsDoc(getDb(), paths.read(me, id)),
        { readAt: at, boardId, ticketId: id },
        { merge: true },
      ).catch(() => {});
    });
  });

  // …and the notifications that pointed here are read too (notifications/autoRead).
  // The bell's own store, so this adds no listener; rows that arrive while the
  // ticket is open are cleared as well, because I am looking at the thread.
  const myInbox = $derived(inboxUnread(me));
  $effect(() => {
    void readTicketNotifications(me, ticketId, $myInbox.data);
  });

  setTicketCtx({
    get boardId() {
      return boardId!;
    },
    get ticketId() {
      return ticketId!;
    },
    get ticket() {
      return ticket!;
    },
    get board() {
      return board!;
    },
    get members() {
      return $mem.data;
    },
    get perms() {
      return perms;
    },
    get me() {
      return me;
    },
    get tz() {
      return tz;
    },
    ticketHref,
    showMessage(id: string) {
      details = false;
      focusMsg = id;
    },
    get readSince() {
      return readSince;
    },
  });

  // A failed message's toast 'Open' lands here: jump to its bubble.
  $effect(() => {
    void outbox.opening;
    if (!ticketId) return;
    untrack(() => {
      const e = outbox.take('message', (x) => x.ticketId === ticketId);
      if (e) {
        details = false;
        focusMsg = e.id;
      }
    });
  });
  const unsent = $derived(
    ticketId ? outbox.messages(ticketId).filter((e) => e.status !== 'sent').length : 0,
  );
  const files = $derived(ticketFiles(boardId, ticketId));
  const fileCount = $derived($files.data.filter((f) => !f.deletedAt).length);

  // ——— phase 3 (§L1): ❓ Waiting for you — a blocking open question addressed to me.
  const questions = $derived(questionMessages(boardId, ticketId));
  const waiting = $derived(blockingQuestions(waitingQuestions($questions.data, me, $tick)));

  // Agents on this board resolve their name / picture from these member rows.
  $effect(() => {
    if (boardId && $mem.data.length) noteBoardMembers(boardId, $mem.data);
  });

  // ——— presence: 'Priya is looking at this'
  $effect(() => {
    if (!boardId || !ticketId || !me || !ticket) return;
    return viewTicket(boardId, ticketId, me);
  });
  const viewing = $derived(viewersOf(boardId, ticketId, me));

  // ——— width (drawer only), remembered per browser
  const WIDTH_KEY = 'tm.ticketDrawer.width';
  const MIN_W = 480;
  let width = $state(760);
  $effect.pre(() => {
    try {
      const w = Number(localStorage.getItem(WIDTH_KEY));
      if (w >= MIN_W) width = w;
    } catch {
      /* private mode */
    }
  });
  function startResize(e: PointerEvent) {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      width = Math.round(
        Math.max(MIN_W, Math.min(window.innerWidth * 0.95, window.innerWidth - ev.clientX)),
      );
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        /* ignore */
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }
  function resizeKey(e: KeyboardEvent) {
    const d = e.key === 'ArrowLeft' ? 40 : e.key === 'ArrowRight' ? -40 : 0;
    if (!d) return;
    e.preventDefault();
    width = Math.max(MIN_W, Math.min(window.innerWidth * 0.95, width + d));
  }

  // ——— Escape closes (after blurring a field, and never over a dialog / picker)
  /** The panel itself, so a press can be judged inside or outside it. */
  let panel: HTMLElement | undefined = $state();
  /** The backdrop only closes for a press that STARTED on it (§U2 — the ghost click). */
  let pressedBackdrop = false;

  /**
   * A press outside the drawer closes it.
   *
   * THERE IS ALREADY A BACKDROP with an onclick, and it is deployed — so this
   * is a second route to the same door rather than a first. A backdrop only
   * works while nothing is painted over it and while the press actually lands
   * on it: a menu, a popover or a portalled layer between the two swallows the
   * click, and the drawer stays open with no way to dismiss it but the ✕.
   * Asking "was the press outside the panel" needs nothing to be on top of
   * anything.
   *
   * POINTERDOWN, NOT CLICK. A click fires where the press ENDED — so selecting
   * text inside the drawer and releasing over the board would close it and
   * throw the selection away.
   */
  function onWindowPointerDown(e: PointerEvent) {
    if (layout !== 'drawer' || !panel) return;
    if (e.button !== 0) return;
    const t = e.target as Element | null;
    if (!t || !t.isConnected) return;

    // Inside the drawer: not an outside press.
    if (panel.contains(t)) return;

    // AND NOT ANYTHING FLOATING ABOVE IT. Menus, dialogs, date pickers and
    // toasts are rendered at the end of <body> rather than inside the panel,
    // so by position they are "outside" it and by intention they are part of
    // it — closing the drawer under an open menu is how a dropdown ends up
    // dismissing the thing it belongs to.
    if (t.closest('dialog, [role="dialog"], [role="menu"], [role="listbox"], [data-floating]'))
      return;

    onClose();
  }

  function onWindowKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || layout !== 'drawer') return;
    if (document.querySelector('dialog[open]')) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) {
      a.blur();
      return;
    }
    onClose();
  }

  // ——— header actions
  // Watching = on the ticket's watchers, or opted in via my board prefs (overrides a muted board).
  const pref = $derived(boardPref(boardId, me));
  const watching = $derived(
    !!ticket &&
      (ticket.watcherUids.includes(me) || !!(ticketId && $pref.data?.watching?.includes(ticketId))),
  );
  const tkey = $derived(ticket?.key ?? key);
  const here = $derived(routes.ticket(tkey));

  function toggleWatch() {
    if (!boardId || !ticketId || !ticket) return;
    const next = !watching;
    const watcherUids = next
      ? [...ticket.watcherUids, me]
      : ticket.watcherUids.filter((u) => u !== me);
    const prefWatching = next
      ? [...($pref.data?.watching ?? []), ticketId]
      : ($pref.data?.watching ?? []).filter((t) => t !== ticketId);
    outbox.queue(
      'ticketWatch',
      { boardId, ticketId, watching: next },
      {
        kind: 'ticket',
        label: `${next ? 'watch' : 'stop watching'} ${tkey}`,
        openTo: here,
        optimistic: [
          { path: paths.ticket(boardId, ticketId), patch: { watcherUids } },
          { path: paths.pref(boardId, me), patch: { watching: prefWatching } },
        ],
      },
    );
  }

  // Phase 6: archive (reversible) or delete (permanent) — no third state and
  // no reason box on either. The archive dialog is a plain confirm.
  let archiveOpen = $state(false);
  let deleteOpen = $state(false);

  /** Archive / restore: the dialog closes at once; the outbox does the rest. */
  function setState(state: 'active' | 'archived') {
    if (!boardId || !ticketId) return;
    outbox.queue(
      'ticketState',
      { boardId, ticketId, state },
      {
        kind: 'ticket',
        label: `${state === 'active' ? 'restore' : 'archive'} ${tkey}`,
        openTo: here,
        optimistic: { path: paths.ticket(boardId, ticketId), patch: { state } },
        onSuccess: () => toast.success(`${tkey} ${state === 'active' ? 'restored' : 'archived'}`),
      },
    );
    archiveOpen = false;
  }

  /** Delete: the ticket disappears from every list at once (a null overlay hides it) and the drawer closes. */
  function del() {
    if (!boardId || !ticketId) return;
    const k = tkey;
    outbox.queue(
      'ticketDelete',
      { boardId, ticketId },
      {
        kind: 'ticket',
        label: `delete ${k}`,
        optimistic: { path: paths.ticket(boardId, ticketId), patch: null },
        onSuccess: () => toast.success(`${k} deleted`),
      },
    );
    deleteOpen = false;
    onClose();
  }

  async function copyLink() {
    const url = new URL(routes.ticket(ticket?.key ?? key), location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.info(url);
    }
  }

  const menu = $derived.by<MenuItem[]>(() => {
    const items: MenuItem[] = [{ label: 'Copy link', icon: Copy, onSelect: copyLink }];
    if (perms.state)
      items.push({ label: 'Archive', icon: Archive, onSelect: () => (archiveOpen = true) });
    if (perms.restore)
      items.push({ label: 'Restore', icon: RotateCcw, onSelect: () => void setState('active') });
    // Only where the board allows permanent delete (perms.delete folds in
    // board.settings.allowDelete); elsewhere the menu offers Archive alone.
    if (perms.delete)
      items.push({
        label: 'Delete ticket',
        icon: Trash2,
        danger: true,
        separator: true,
        onSelect: () => (deleteOpen = true),
      });
    return items;
  });

  // A ticket still stored as 'cancelled' (phase 6 migration not run yet) reads as archived.
  const stateLabel = $derived(ticket && ticket.state !== 'active' ? 'Archived' : null);
</script>

<svelte:window onkeydown={onWindowKey} onpointerdown={onWindowPointerDown} />

{#snippet body()}
  <header class="tm-safe-top flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
    <nav class="flex min-w-0 flex-1 items-center gap-1.5 text-sm" aria-label="Breadcrumb">
      {#if board}
        <a href={routes.board(board.key)} class="truncate text-muted hover:text-text"
          >{board.name}</a
        >
        <span class="text-subtle" aria-hidden="true">›</span>
      {/if}
      <button
        type="button"
        class="font-mono text-sm hover:text-accent"
        title="Copy link"
        onclick={copyLink}
      >
        {tkey}
      </button>
      {#if stateLabel}<Badge tone="warning">{stateLabel}</Badge>{/if}
      {#each aggChips as a (a.id)}
        <!-- aggregates.html: '$402.27' · '2 h' — the ticket's counters, kept by messagePost. -->
        <span
          data-agg={a.id}
          data-cost={a.id === 'cost' ? '' : undefined}
          class="inline-flex shrink-0 items-center rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted tabular-nums"
          title={a.title}
        >
          {a.text}
          <span class="hidden sm:inline">&nbsp;{a.label}</span>
        </span>
      {/each}
      {#if waiting.length}
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent"
          title={waiting.map((q) => q.title).join(' · ')}
          data-waiting
          onclick={() => ((details = false), (focusMsg = waiting[0]!.messageId))}
        >
          <span aria-hidden="true">❓</span>{waitingBadgeLabel(waiting.length)}
        </button>
      {/if}
      {#if unsent}
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning"
          title="Messages not sent yet"
          onclick={() =>
            (focusMsg =
              outbox.messages(ticketId ?? '').find((e) => e.status !== 'sent')?.id ?? null)}
        >
          <TriangleAlert size={12} aria-hidden="true" />{unsent} unsent
        </button>
      {/if}
    </nav>
    <!-- §L3: 🟢 Working · Running tests (3/12) — from the board's one live-status listener (§W: the RTDB). -->
    <TicketAgentHealth {boardId} {ticketId} withName {tz} class="hidden max-w-56 sm:inline-flex" />
    {#if $viewing.length}
      <div
        class="hidden items-center pr-1 sm:flex"
        aria-label="{$viewing.length} other people viewing"
      >
        {#each $viewing.slice(0, 4) as uid (uid)}<span class="-ml-1.5 first:ml-0"
            ><PersonAvatar {uid} size={24} ring suffix="is viewing" /></span
          >{/each}
        {#if $viewing.length > 4}<span class="ml-1 text-xs text-muted">+{$viewing.length - 4}</span
          >{/if}
      </div>
    {/if}
    {#if ticket}
      <Button
        size="sm"
        variant="ghost"
        icon={watching ? BellOff : Bell}
        onclick={toggleWatch}
        aria-pressed={watching}
        class="tm-press"
      >
        <span class="hidden sm:inline">{watching ? 'Watching' : 'Watch'}</span>
      </Button>
      <Menu items={menu} placement="bottom-end">
        {#snippet trigger(props)}
          <IconButton icon={MoreHorizontal} label="More actions" {...props} />
        {/snippet}
      </Menu>
    {/if}
    {#if layout === 'drawer'}
      <IconButton icon={Maximize2} label="Open as page" onclick={() => goto(here)} />
    {/if}
    <IconButton icon={X} label="Close" onclick={onClose} />
  </header>

  {#if $idx.loading || (boardId && ($tk.loading || $bd.loading))}
    <!-- Shaped like the two panes, never a centred spinner. -->
    <div class="flex min-h-0 flex-1" aria-busy="true" aria-label="Loading the ticket">
      <div class="flex min-w-0 flex-1 flex-col gap-3 p-5">
        <Skeleton width="65%" height="1.5rem" />
        <Skeleton width="92%" /><Skeleton width="80%" /><Skeleton width="45%" />
        <div class="mt-auto flex flex-col gap-4">
          {#each [0, 1, 2] as i (i)}
            <div class="flex gap-2 {i === 1 ? 'justify-end' : ''}">
              {#if i !== 1}<Skeleton width="28px" height="28px" class="rounded-full" />{/if}
              <Skeleton width={i === 1 ? '45%' : '60%'} height="3rem" class="rounded-2xl" />
            </div>
          {/each}
          <Skeleton height="5.5rem" class="rounded-lg" />
        </div>
      </div>
      <div class="hidden w-72 shrink-0 flex-col gap-3 border-l border-line p-4 sm:flex">
        {#each [0, 1, 2, 3, 4, 5] as i (i)}
          <div class="flex items-center gap-2">
            <Skeleton width="5rem" height="0.75rem" /><Skeleton
              width="55%"
              height="1.5rem"
              class="rounded-md"
            />
          </div>
        {/each}
      </div>
    </div>
  {:else if !$idx.exists && !$idx.error}
    <EmptyState
      title="No ticket {key}"
      description="Check the key — or it may never have existed."
    />
  {:else if $idx.data?.deleted}
    <EmptyState
      title="{key} was deleted"
      description="Deleted tickets are gone for good; their keys are never reused."
    />
  {:else if $tk.error || $bd.error || $idx.error}
    <EmptyState
      title="You can't see {key}"
      description="It's on a board you're not a member of. Ask someone on that board to invite you."
    />
  {:else if !ticket || !board}
    <EmptyState title="{key} isn't here" description="It may have just been deleted." />
  {:else}
    <!-- Panels capture boardId/ticketId at mount (composer drafts, listeners): re-mount per ticket. -->
    {#key ticketId}
      <!-- tm-fade-in, not in:fade: a frozen JS transition would leave the body invisible (§U). -->
      <div
        class="tm-fade-in @container/ticket relative flex min-h-0 flex-1 flex-col"
        data-open-ticket={ticketId}
      >
        <div class="relative flex min-h-0 flex-1 @2xl/ticket:flex-row">
          <!-- LEFT: title + description fixed on top, the thread scrolling below, the composer pinned. -->
          <section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Conversation">
            <div
              class="flex max-h-[45%] shrink-0 flex-col gap-2 overflow-y-auto border-b border-line px-5 pt-4 pb-3"
            >
              <TicketTitle />
              <TicketDescription />
              <button
                type="button"
                onclick={() => (details = true)}
                class="tm-press inline-flex w-fit items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-text @2xl/ticket:hidden"
              >
                <PanelRight size={14} aria-hidden="true" /> Details{#if fileCount}
                  · {fileCount} {fileCount === 1 ? 'file' : 'files'}{/if}
              </button>
            </div>
            <Thread bind:focus={focusMsg} />
          </section>

          <!-- RIGHT: fields, attachments, activity — its own scroll. Over the left pane when narrow. -->
          <aside
            aria-label="Details"
            class="@container absolute inset-0 z-20 flex-col overflow-y-auto overscroll-contain bg-surface
              @2xl/ticket:static @2xl/ticket:z-auto @2xl/ticket:flex @2xl/ticket:w-80 @2xl/ticket:shrink-0 @2xl/ticket:border-l @2xl/ticket:border-line
              {details ? 'flex tm-fade-in' : 'hidden'}"
          >
            <div
              class="sticky top-0 z-[3] flex items-center gap-2 border-b border-line bg-surface px-2 py-1.5 @2xl/ticket:hidden"
            >
              <IconButton
                icon={ArrowLeft}
                label="Back to the conversation"
                onclick={() => (details = false)}
              />
              <span class="text-sm font-medium">Details</span>
            </div>
            <!-- Phase 3 (§L2): task lists sit at the TOP of the right pane, above the fields. -->
            <Tasklists />
            <PaneSection id="details" title="Details">
              <div class="flex flex-col gap-4 pt-1">
                <FieldPanel />
                <RelatedPanel />
              </div>
            </PaneSection>
            <PaneSection id="files" title="Attachments" count={fileCount}>
              <FilesTab />
            </PaneSection>
            <PaneSection id="activity" title="Activity">
              <ActivityTab />
            </PaneSection>
          </aside>
        </div>
      </div>

      <!-- The in-app file viewer (overlay) for every card in this ticket. -->
      <TicketFileViewer />
    {/key}
  {/if}
{/snippet}

{#if layout === 'page'}
  <main class="flex h-dvh flex-col bg-surface text-text" aria-label="Ticket {tkey}">
    <div class="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col border-x border-line">
      {@render body()}
    </div>
  </main>
{:else}
  <!--
    Backdrop: fades in; a press that BEGAN on it closes the drawer.

    Why not a plain onclick (§U2): on a phone the tap that opens a card is
    followed by the browser's compatibility click, which lands on this
    backdrop — it did not exist when the finger went down. The ticket opened
    and shut again in the same tap, which is what "opening a task doesn't work
    on mobile" was. Requiring the pointerdown to have landed here makes the
    ghost click harmless without adding a timer.
  -->
  <div
    class="tm-fade-in fixed inset-0 z-40 bg-overlay/60"
    aria-hidden="true"
    onpointerdown={(e) => (pressedBackdrop = e.target === e.currentTarget)}
    onclick={() => {
      if (!pressedBackdrop) return;
      pressedBackdrop = false;
      onClose();
    }}
  ></div>
  <aside
    bind:this={panel}
    aria-label="Ticket {tkey}"
    style="width:{width}px"
    class="tm-slide-in-right fixed inset-y-0 right-0 z-40 flex max-w-full flex-col border-l border-line bg-surface text-text shadow-pop"
  >
    <!-- A focusable separator is an interactive widget (ARIA 1.2 window splitter). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize ticket panel"
      aria-valuenow={width}
      tabindex="0"
      class="absolute inset-y-0 -left-1 z-30 hidden w-2 cursor-col-resize hover:bg-accent/30 focus:bg-accent/30 sm:block"
      onpointerdown={startResize}
      onkeydown={resizeKey}
    ></div>
    {@render body()}
  </aside>
{/if}

<Dialog
  bind:open={archiveOpen}
  title="Archive {ticket?.key ?? ''}?"
  description="It becomes read-only, its thread closes, and it leaves every default view. An admin can restore it."
  size="sm"
>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (archiveOpen = false)}>Keep it</Button>
    <Button variant="primary" onclick={() => setState('archived')}>Archive</Button>
  {/snippet}
</Dialog>

<!-- Phase 6: permanent delete asks once, and asks for nothing else. -->
<Dialog
  bind:open={deleteOpen}
  title="Delete {ticket?.key ?? ''}? This cannot be undone."
  size="sm"
  description="The ticket, its thread, activity and files are removed. Links to {ticket?.key ??
    'it'} will say it was deleted."
>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (deleteOpen = false)}>Keep it</Button>
    <Button variant="danger" onclick={del}>Delete</Button>
  {/snippet}
</Dialog>

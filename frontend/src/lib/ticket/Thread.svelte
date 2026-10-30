<!--
  The thread (app.json › Thread; agents.html § K · §W): messages newest-first
  50 at a time (oldest at the top, 'Load earlier' pulls the next page — out of
  the ticket's own inline window, and only past it out of a data page), a
  pinned strip, day separators + author groups (thread.ts, Google Chat style:
  mine on the right), a 'New messages' divider at my read pointer as it was
  when the ticket opened (the drawer marks it read on open), 'Seen by' /
  typing under the last message, and the composer.

  Layout: this fills the left pane under the title. The messages scroll in
  their own box ([data-ticket-scroll]); the composer sits below it, pinned to
  the bottom whether the thread is empty or long; an empty thread's message
  is centred in the space above the composer.

  Unsent messages are outbox entries drawn as bubbles (pending.svelte.ts).
  Messages arriving while the ticket is open advance my read pointer when the
  bottom is in view (and the tab is visible), but stay below the divider.

  Seen by: the read pointers of this ticket (a collection-group query on
  reads/ filtered by board + ticket, which rules open to the board) whose
  readAt covers the last message, plus whoever is looking at it right now
  (RTDB presence).
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { doc as fsDoc, setDoc } from 'firebase/firestore';
  import { ArrowDown, Pin } from 'lucide-svelte';
  import { paths, type Message } from '@tm/shared';
  import { getDb } from '$lib/firebase/client';
  import { plainText, snippet } from '$lib/editor';
  import { Skeleton, toast } from '$lib/ui';
  import { getTicketCtx } from './context';
  import { myRead, PAGE, pinnedMessages, threadPage, ticketReads } from './data';
  import { pendingFor, type ThreadItem } from './pending.svelte';
  import { typers, viewers } from './presence';
  import { dayLabel, firstUnread, groupThread, mergeThread } from './thread';
  import MessageItem from './MessageItem.svelte';
  import PersonAvatar from './PersonAvatar.svelte';
  import Composer from './Composer.svelte';
  import PersonName from './PersonName.svelte';

  interface Props {
    /** A message to scroll to and highlight (?m=, pinned strip, Files 'jump to'). */
    focus?: string | null;
  }
  let { focus = $bindable(null) }: Props = $props();

  const t = getTicketCtx();
  const boardId = t.boardId;
  const ticketId = t.ticketId;

  let count = $state(PAGE);
  const pageStore = $derived(threadPage(boardId, ticketId, count));
  const pins = pinnedMessages(boardId, ticketId);
  const read = myRead(t.me, ticketId);
  const typing = typers(boardId, ticketId, t.me);
  const looking = viewers(boardId, ticketId, t.me);
  const reads = ticketReads(boardId, ticketId);
  /** Everyone but me who has seen the latest message: read pointers ∪ presence. */
  const seenBy = $derived.by(() => {
    const last = t.ticket.lastMessageAt ?? 0;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway set inside $derived
    const uids = new Set($looking);
    for (const r of $reads) if (r.uid !== t.me && r.readAt >= last) uids.add(r.uid);
    return [...uids];
  });

  const loaded = $derived($pageStore.data);
  /** Fewer than asked for = the start of the thread is loaded. */
  const atStart = $derived(!$pageStore.loading && loaded.length < count);

  // A bubble whose stored message has arrived gives way to it (same id: mergeThread keeps the stored one).
  const items = $derived(
    mergeThread<ThreadItem>(
      loaded as ThreadItem[],
      pendingFor(ticketId).map((p) => ({ ...p, pending: true as const })) as ThreadItem[],
    ),
  );
  const sections = $derived(groupThread(items, t.tz));
  const byId = $derived(new Map(loaded.map((m) => [m.id, m])));

  // The 'New messages' divider sits at my read pointer AS IT WAS when I opened
  // the ticket (the drawer captured it before marking the ticket read).
  const readAtOnOpen = $derived(t.readSince);
  const newId = $derived(
    readAtOnOpen === undefined ? null : firstUnread(items, readAtOnOpen, t.me),
  );

  // ——— scrolling
  let root: HTMLElement | undefined = $state();
  let bottom: HTMLElement | undefined = $state();
  let scroller: HTMLElement | null = $state(null);
  let atBottom = $state(false);
  let unseen = $state(0);
  let lastNewest: string | null = null;
  let initial = true;

  $effect(() => {
    if (!bottom) return;
    const io = new IntersectionObserver(([e]) => (atBottom = !!e?.isIntersecting), {
      root: scroller,
      threshold: 0,
    });
    io.observe(bottom);
    return () => io.disconnect();
  });

  function toBottom(smooth = false) {
    bottom?.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'auto' });
  }

  // First load: jump to the focused message, else the 'New' divider, else the bottom.
  // Later: follow new messages when already at the bottom, otherwise count them.
  $effect(() => {
    const newest = items[items.length - 1];
    if ($pageStore.loading || readAtOnOpen === undefined) return;
    const id = newest?.id ?? null;
    untrack(() => {
      if (initial) {
        initial = false;
        lastNewest = id;
        void tick().then(() => {
          if (focus) return; // handled by the focus effect
          const el = newId ? document.getElementById(`msg-${newId}`) : null;
          // Open at the divider: it sits near the top, the new messages below it.
          if (el) el.scrollIntoView({ block: 'start' });
          else toBottom();
        });
        return;
      }
      if (id === lastNewest) return;
      lastNewest = id;
      const mine = newest && newest.authorUid === t.me;
      if (atBottom || mine) void tick().then(() => toBottom(true));
      else unseen += 1;
    });
  });
  $effect(() => {
    if (atBottom) unseen = 0;
  });

  // ——— mark read at the bottom
  let visible = $state(
    typeof document === 'undefined' ? true : document.visibilityState === 'visible',
  );
  let lastWritten = 0;
  $effect(() => {
    const last = t.ticket.lastMessageAt ?? 0;
    const readAt = $read.data?.readAt ?? 0;
    if (!atBottom || !visible || !t.me || $read.loading) return;
    if (readAtOnOpen !== undefined && last <= readAt) return;
    const at = Math.max(Date.now(), last);
    if (at - lastWritten < 3000) return;
    lastWritten = at;
    void setDoc(
      fsDoc(getDb(), paths.read(t.me, ticketId)),
      { readAt: at, boardId, ticketId },
      { merge: true },
    ).catch(() => {
      lastWritten = 0;
    });
  });

  // ——— paging
  let loadingOlder = $state(false);
  /** Distance from the bottom before the bigger page arrived: kept so the view doesn't jump. */
  let keepFromBottom = 0;
  function loadOlder() {
    if (atStart || loadingOlder) return;
    keepFromBottom = scroller ? scroller.scrollHeight - scroller.scrollTop : 0;
    loadingOlder = true;
    count += PAGE;
  }
  $effect(() => {
    if (!loadingOlder || $pageStore.loading) return;
    const el = scroller;
    untrack(() => {
      loadingOlder = false;
      void tick().then(() => {
        if (el) el.scrollTop = el.scrollHeight - keepFromBottom;
      });
    });
  });

  // ——— focus a message (paging back until it is loaded)
  let highlighted = $state<string | null>(null);
  $effect(() => {
    const id = focus;
    if (!id || $pageStore.loading) return;
    untrack(() => {
      void tick().then(() => {
        const el = document.getElementById(`msg-${id}`);
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          highlighted = id;
          focus = null;
          setTimeout(() => {
            if (highlighted === id) highlighted = null;
          }, 2500);
        } else if (!atStart && count < 2000) {
          count += PAGE;
        } else {
          focus = null;
          toast.info('That message is not in this thread any more');
        }
      });
    });
  });

  // ——— reply
  let replyTo = $state<string | null>(null);
  const replyQuoted = $derived.by(() => {
    if (!replyTo) return null;
    const m = byId.get(replyTo);
    return m ? { authorName: m.authorName, text: snippet(plainText(m.body.doc), 100) } : null;
  });
  function quotedOf(m: ThreadItem): Pick<Message, 'authorName' | 'body' | 'deletedAt'> | null {
    if (!m.replyTo) return null;
    return byId.get(m.replyTo) ?? null;
  }

  // ——— pinned strip
  const pinned = $derived($pins.data.filter((m) => !m.deletedAt));
  let pinsOpen = $state(false);

  // ——— typing line
  const typingNames = $derived($typing.slice(0, 3));
</script>

<svelte:document onvisibilitychange={() => (visible = document.visibilityState === 'visible')} />

<section bind:this={root} class="relative flex min-h-0 flex-1 flex-col" aria-label="Thread">
  {#if pinned.length}
    <div class="shrink-0 border-b border-line bg-surface-2/70 px-5 py-1.5 text-sm">
      <button
        type="button"
        class="flex w-full items-center gap-2 text-left"
        aria-expanded={pinsOpen}
        onclick={() => (pinned.length > 1 ? (pinsOpen = !pinsOpen) : (focus = pinned[0]!.id))}
      >
        <Pin size={14} class="shrink-0 text-accent" />
        <span class="shrink-0 text-muted">Pinned{pinned.length > 1 ? ` ${pinned.length}` : ''}</span
        >
        <span class="truncate">— {snippet(plainText(pinned[0]!.body.doc), 90)}</span>
      </button>
      {#if pinsOpen}
        <ul class="tm-fade-in mt-1 flex max-h-48 flex-col gap-0.5 overflow-y-auto">
          {#each pinned as p (p.id)}
            <li>
              <button
                type="button"
                class="w-full truncate rounded px-2 py-1 text-left hover:bg-surface"
                onclick={() => {
                  focus = p.id;
                  pinsOpen = false;
                }}
              >
                <span class="text-muted">{p.authorName}:</span>
                {snippet(plainText(p.body.doc), 110)}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  <!-- The messages scroll here, and only here. -->
  <div
    bind:this={scroller}
    class="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    data-ticket-scroll
  >
    <div
      class="flex min-h-full flex-col justify-end py-2"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
    >
      {#if $pageStore.loading && !loaded.length}
        <!-- Bubble-shaped placeholders, bottom-aligned like the real thread. -->
        <div class="flex flex-col gap-3 px-4 py-2" aria-busy="true" aria-label="Loading the thread">
          {#each [0.55, 0.4, 0.62, 0.35] as w, i (i)}
            <div class="flex items-end gap-2 {i % 2 ? 'justify-end' : ''}">
              {#if i % 2 === 0}<Skeleton
                  width="28px"
                  height="28px"
                  class="shrink-0 rounded-full"
                />{/if}
              <Skeleton width="{w * 100}%" height="{i === 2 ? 4 : 2.6}rem" class="rounded-2xl" />
            </div>
          {/each}
        </div>
      {:else if $pageStore.error}
        <p class="m-auto px-5 py-6 text-sm text-danger">Could not load the thread.</p>
      {:else}
        {#if !atStart}
          <div class="flex justify-center py-2">
            <button
              type="button"
              class="tm-press rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-text"
              onclick={loadOlder}
              disabled={loadingOlder}
            >
              {loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </button>
          </div>
        {:else if !items.length}
          <div class="m-auto flex flex-col items-center gap-1 px-6 py-8 text-center">
            <p class="text-sm font-medium">No messages yet</p>
            <p class="text-sm text-muted">Start the conversation below.</p>
          </div>
        {/if}

        {#each sections as sec (sec.day)}
          <div
            class="sticky top-0 z-[4] flex justify-center py-1.5"
            role="separator"
            aria-label={dayLabel(sec.day, Date.now(), t.tz)}
          >
            <span
              class="rounded-full border border-line bg-surface/95 px-2.5 py-0.5 text-xs text-muted shadow-sm backdrop-blur"
              >{dayLabel(sec.day, Date.now(), t.tz)}</span
            >
          </div>
          {#each sec.groups as g (g.key)}
            {#each g.messages as m, i (m.id)}
              {#if m.id === newId}
                <div
                  class="my-2 flex items-center gap-2 px-5 text-xs font-medium text-danger"
                  role="separator"
                  aria-label="New messages"
                >
                  <span class="h-px flex-1 bg-danger/40"></span>New messages<span
                    class="h-px flex-1 bg-danger/40"
                  ></span>
                </div>
              {/if}
              <MessageItem
                {m}
                head={i === 0 || m.id === newId}
                tail={i === g.messages.length - 1 || g.messages[i + 1]?.id === newId}
                quoted={quotedOf(m)}
                highlight={highlighted === m.id}
                onreply={(id) => (replyTo = id)}
              />
            {/each}
          {/each}
        {/each}

        {#if seenBy.length}
          <div
            class="flex items-center justify-end gap-1 px-5 pt-1 text-xs text-subtle"
            aria-label="Seen by {seenBy.length} people"
          >
            Seen by
            {#each seenBy.slice(0, 6) as uid (uid)}<PersonAvatar
                {uid}
                size={16}
                suffix="has seen this"
              />{/each}
          </div>
        {/if}
      {/if}
      <div bind:this={bottom} class="h-px shrink-0" aria-hidden="true"></div>
    </div>
  </div>

  <!-- Pinned to the bottom of the pane. -->
  <div class="relative shrink-0">
    {#if unseen > 0 && !atBottom}
      <div class="pointer-events-none absolute -top-10 flex w-full justify-center">
        <button
          type="button"
          class="tm-press tm-pop pointer-events-auto flex items-center gap-1 rounded-full bg-accent px-3 py-1 text-xs text-accent-fg shadow-pop"
          onclick={() => toBottom(true)}
        >
          <ArrowDown size={12} />
          {unseen} new {unseen === 1 ? 'message' : 'messages'}
        </button>
      </div>
    {/if}
    {#if typingNames.length}
      <p class="border-t border-line bg-surface px-5 pt-1 text-xs text-muted" aria-live="polite">
        {#each typingNames as u, i (u)}{#if i > 0}{i === typingNames.length - 1
              ? ' and '
              : ', '}{/if}<PersonName uid={u} />{/each}
        {typingNames.length === 1 ? 'is' : 'are'} typing…
      </p>
    {/if}
    <Composer
      bind:replyTo
      quoted={replyQuoted}
      onsent={() => void tick().then(() => toBottom(true))}
    />
  </div>
</section>

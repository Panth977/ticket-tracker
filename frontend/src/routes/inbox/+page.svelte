<!--
  Inbox (app.json › Inbox, route /inbox):
    chips  Unread · Mentions · Assigned · Invitations · All · Snoozed   (?tab=)
    list   collapsed Notification rows; invitations carry Accept / Decline
    keys   j / k move · e archive · s snooze · Enter opens the ticket drawer beside the list
  The ticket opens in <TicketDrawer> with ?ticket=KEY in the URL, so a reload
  or a shared link lands on the same ticket.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    Archive,
    CheckCheck,
    Clock,
    Inbox as InboxIcon,
    Mail,
    MailOpen,
    Undo2,
  } from 'lucide-svelte';
  import type { Invite } from '@tm/shared';
  import { auth } from '$lib/firebase/auth.svelte';
  import { useShortcut } from '$lib/keyboard/useShortcut.svelte';
  import { routes } from '$lib/layout/routes';
  import {
    archive,
    markRead,
    markUnread,
    setFlags,
    snooze,
    unsnooze,
  } from '$lib/notifications/actions';
  import {
    collapse,
    groupsForTab,
    INBOX_TABS,
    isSnoozed,
    parseTab,
    tabCounts,
    type Group,
    type InboxTab,
    type Row,
  } from '$lib/notifications/inbox';
  import InviteRow from '$lib/notifications/InviteRow.svelte';
  import NotificationRow from '$lib/notifications/NotificationRow.svelte';
  import PushPrompt from '$lib/notifications/PushPrompt.svelte';
  import { defaultSnooze, formatWhen, snoozeOptions } from '$lib/notifications/snooze';
  import { clock, inboxFeed } from '$lib/notifications/stores';
  import SearchProviders from '$lib/search/SearchProviders.svelte';
  import { myInvites } from '$lib/stores';
  import TicketDrawer from '$lib/ticket/TicketDrawer.svelte';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import Kbd from '$lib/ui/Kbd.svelte';
  import Menu from '$lib/ui/Menu.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import Tabs from '$lib/ui/Tabs.svelte';

  type Entry =
    | { kind: 'group'; key: string; group: Group }
    | {
        kind: 'invite';
        key: string;
        invite: Invite & { id: string };
        inboxIds: string[];
        unread: boolean;
      };

  const now = clock(30_000);
  const uid = $derived(auth.uid);
  const tz = $derived(auth.profile?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const feed = $derived(inboxFeed(uid));
  const invites = $derived(myInvites(auth.user?.emailVerified ? auth.user.email : null));

  const tab: InboxTab = $derived(parseTab(page.url.searchParams.get('tab')));
  const ticketKey = $derived(page.url.searchParams.get('ticket'));

  const rows = $derived($feed.data as Row[]);
  const pending = $derived(new Map($invites.data.map((i) => [i.id, i])));
  const counts = $derived.by(() => {
    const c = tabCounts(rows, $now);
    // Invitations: the pending invites are the truth (an invite may predate its inbox row).
    c.invitations = pending.size;
    return c;
  });

  /** What the current tab lists, in order. */
  const entries: Entry[] = $derived.by(() => {
    const groups = groupsForTab(rows, tab, $now);
    const out: Entry[] = [];
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local to this derivation, never mutated after
    const seenInvites = new Set<string>();
    for (const g of groups) {
      const inv =
        g.head.event === 'invited' && g.head.inviteId ? pending.get(g.head.inviteId) : undefined;
      if (inv) {
        seenInvites.add(inv.id);
        out.push({ kind: 'invite', key: g.key, invite: inv, inboxIds: g.ids, unread: g.unread });
      } else out.push({ kind: 'group', key: g.key, group: g });
    }
    if (tab === 'invitations' || tab === 'all' || tab === 'unread') {
      // Pending invites with no (visible) inbox row yet: still answerable here.
      const all = collapse(rows);
      for (const inv of pending.values()) {
        if (seenInvites.has(inv.id)) continue;
        const g = all.find((x) => x.head.inviteId === inv.id);
        // Archived or snoozed away from this tab → respect that, except on Invitations.
        if (g && tab !== 'invitations') continue;
        out.push({
          kind: 'invite',
          key: `invite:${inv.id}`,
          invite: inv,
          inboxIds: g?.ids ?? [],
          unread: g?.unread ?? true,
        });
      }
      out.sort((a, b) => createdAt(b) - createdAt(a));
    }
    return out;
  });
  function createdAt(e: Entry) {
    return e.kind === 'group' ? e.group.head.createdAt : e.invite.createdAt;
  }

  // ── selection ────────────────────────────────────────────────────────────
  let selectedKey = $state<string | null>(null);
  const selectedIndex = $derived(
    Math.max(
      0,
      entries.findIndex((e) => e.key === selectedKey),
    ),
  );
  const selected = $derived(entries[selectedIndex] ?? null);

  // Keep a sensible selection when rows leave (archived) — move to the neighbour, not the top.
  let lastIndex = 0;
  $effect(() => {
    if (!entries.length) return;
    if (selectedKey && entries.some((e) => e.key === selectedKey)) {
      lastIndex = entries.findIndex((e) => e.key === selectedKey);
      return;
    }
    selectedKey = entries[Math.min(lastIndex, entries.length - 1)]!.key;
  });

  function select(i: number) {
    const e = entries[Math.max(0, Math.min(entries.length - 1, i))];
    if (!e) return;
    selectedKey = e.key;
    document
      .querySelector(`[data-inbox-row="${CSS.escape(e.key)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  function idsOf(e: Entry | null): string[] {
    if (!e) return [];
    return e.kind === 'group' ? e.group.ids : e.inboxIds;
  }

  function withParams(mut: (p: URLSearchParams) => void) {
    const u = new URL(page.url);
    mut(u.searchParams);
    return `${u.pathname}${u.search}`;
  }

  function open(e: Entry | null) {
    if (!e || !uid) return;
    selectedKey = e.key;
    if (e.kind === 'invite') return; // answered with its own buttons
    const g = e.group;
    if (g.unread) void markRead(uid, g.ids);
    if (g.head.ticketKey) {
      const key = g.head.ticketKey;
      void goto(
        withParams((p) => p.set('ticket', key)),
        { keepFocus: true, noScroll: true },
      );
    } else if (g.head.event === 'invited') {
      void goto(routes.invitations());
    }
  }
  function closeTicket() {
    void goto(
      withParams((p) => p.delete('ticket')),
      { keepFocus: true, noScroll: true },
    );
  }

  function doArchive(e: Entry | null) {
    const ids = idsOf(e);
    if (uid && ids.length) void archive(uid, ids);
  }
  function doSnooze(e: Entry | null, until = defaultSnooze(Date.now(), tz).until) {
    const ids = idsOf(e);
    if (uid && ids.length) void snooze(uid, ids, until, formatWhen(until, tz));
  }
  function markAllRead() {
    if (!uid) return;
    const ids = rows.filter((r) => r.readAt == null && !isSnoozed(r, $now)).map((r) => r.id);
    void markRead(uid, ids);
  }

  useShortcut('j', () => select(selectedIndex + 1), { description: 'Next notification' });
  useShortcut('k', () => select(selectedIndex - 1), { description: 'Previous notification' });
  useShortcut('e', () => doArchive(selected), { description: 'Archive' });
  useShortcut('s', () => doSnooze(selected), { description: 'Snooze until tomorrow' });
  // Enter on a focused button / link is that control's own click, not "open".
  useShortcut(
    'enter',
    (ev) => {
      if (
        (ev?.target as HTMLElement | null)?.closest?.(
          'button, a, input, textarea, [contenteditable]',
        )
      )
        return false;
      open(selected);
    },
    { description: 'Open ticket' },
  );
  useShortcut(
    'shift+u',
    () => {
      const e = selected;
      if (!uid || !e || e.kind !== 'group') return;
      void (e.group.unread ? markRead(uid, e.group.ids) : markUnread(uid, e.group.ids));
    },
    { description: 'Toggle read' },
  );

  const tabItems = $derived(
    INBOX_TABS.map((t) => ({
      id: t.id,
      label: t.label,
      href: routes.inbox(t.id === 'unread' ? undefined : t.id),
      count: counts[t.id] || undefined,
    })),
  );

  const EMPTY: Record<InboxTab, { title: string; description: string }> = {
    unread: {
      title: 'All caught up',
      description: 'New mentions, assignments and updates land here.',
    },
    mentions: {
      title: 'No mentions',
      description: 'When someone @mentions you, it shows up here.',
    },
    assigned: {
      title: 'Nothing assigned',
      description: 'Tickets people assign to you show up here.',
    },
    invitations: {
      title: 'No invitations',
      description: 'Invitations to boards appear here for you to accept.',
    },
    all: {
      title: 'Your inbox is empty',
      description: 'Notifications you haven’t archived appear here.',
    },
    snoozed: {
      title: 'Nothing snoozed',
      description: 'Press s on a notification to bring it back later.',
    },
  };
</script>

<svelte:head><title>Inbox · TaskManager</title></svelte:head>

<SearchProviders />

<div class="flex h-full min-h-dvh flex-col {ticketKey ? 'lg:pr-[min(42rem,55vw)]' : ''}">
  <header
    class="sticky top-0 z-10 border-b border-line bg-bg/95 px-4 pt-4 pb-2 backdrop-blur md:top-0"
  >
    <div class="flex items-center gap-3">
      <h1 class="flex-1 text-lg font-semibold">Inbox</h1>
      <Button
        size="sm"
        variant="ghost"
        icon={CheckCheck}
        onclick={markAllRead}
        disabled={!counts.unread}
      >
        Mark all read
      </Button>
    </div>
    <Tabs items={tabItems} value={tab} label="Inbox filters" class="mt-2 -mx-1" />
  </header>

  <PushPrompt />

  <div class="flex-1">
    {#if $feed.loading}
      <div class="flex flex-col gap-3 p-4">
        {#each [0, 1, 2, 3, 4, 5] as i (i)}<Skeleton height="1.75rem" />{/each}
      </div>
    {:else if $feed.error}
      <EmptyState
        icon={InboxIcon}
        title="Couldn't load your inbox"
        description={$feed.error.message}
        class="mt-16"
      />
    {:else if !entries.length}
      <EmptyState
        icon={tab === 'snoozed' ? Clock : tab === 'invitations' ? Mail : InboxIcon}
        {...EMPTY[tab]}
        class="mt-16"
      >
        {#snippet action()}
          {#if tab !== 'all'}<Button size="sm" href={routes.inbox('all')}>See everything</Button
            >{/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div role="listbox" aria-label="Notifications" tabindex="-1">
        {#each entries as e (e.key)}
          {#if e.kind === 'invite'}
            <InviteRow
              invite={e.invite}
              inboxIds={e.inboxIds}
              unread={e.unread}
              now={$now}
              selected={e.key === selected?.key}
              onselect={() => (selectedKey = e.key)}
            />
          {:else}
            {@const g = e.group}
            <NotificationRow
              group={g}
              now={$now}
              selected={e.key === selected?.key}
              onopen={() => open(e)}
            >
              {#snippet actions()}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <span
                  class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100
                  {e.key === selected?.key ? 'opacity-100' : ''}"
                  onclick={(ev) => ev.stopPropagation()}
                >
                  {#if g.head.event === 'invited'}
                    <span class="px-1 text-xs text-subtle">No longer pending</span>
                  {/if}
                  {#if tab === 'snoozed' && uid}
                    <span class="px-1 text-xs text-subtle"
                      >until {formatWhen(g.head.snoozedUntil ?? 0, tz)}</span
                    >
                    <IconButton
                      size="sm"
                      icon={Undo2}
                      label="Unsnooze"
                      onclick={() => void unsnooze(uid, g.ids)}
                    />
                  {:else}
                    <Menu
                      placement="bottom-end"
                      items={snoozeOptions(Date.now(), tz).map((o) => ({
                        label: `${o.label} · ${formatWhen(o.until, tz)}`,
                        onSelect: () => doSnooze(e, o.until),
                      }))}
                    >
                      {#snippet trigger(props)}
                        <button
                          {...props}
                          type="button"
                          aria-label="Snooze"
                          title="Snooze (s)"
                          class="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
                        >
                          <Clock size={15} aria-hidden="true" />
                        </button>
                      {/snippet}
                    </Menu>
                  {/if}
                  {#if uid}
                    <IconButton
                      size="sm"
                      icon={g.unread ? MailOpen : Mail}
                      label={g.unread ? 'Mark read' : 'Mark unread'}
                      onclick={() =>
                        void (g.unread
                          ? markRead(uid, g.ids)
                          : setFlags(uid, g.ids, { readAt: null }))}
                    />
                  {/if}
                  <IconButton
                    size="sm"
                    icon={Archive}
                    label="Archive (e)"
                    onclick={() => doArchive(e)}
                  />
                </span>
              {/snippet}
            </NotificationRow>
          {/if}
        {/each}
      </div>
      <p class="hidden items-center gap-3 px-4 py-3 text-xs text-subtle md:flex">
        <span><Kbd keys="j" /> <Kbd keys="k" /> move</span>
        <span><Kbd keys="enter" /> open</span>
        <span><Kbd keys="e" /> archive</span>
        <span><Kbd keys="s" /> snooze</span>
        <span><Kbd keys="shift+u" /> read / unread</span>
      </p>
    {/if}
  </div>
</div>

{#if ticketKey}
  {#key ticketKey}
    <TicketDrawer {ticketKey} onClose={closeTicket} />
  {/key}
{/if}

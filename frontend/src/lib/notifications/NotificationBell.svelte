<!--
  Notification bell (app.json): a realtime listener on
    users/{uid}/inbox where(archivedAt == null) orderBy(createdAt desc) limit(50)
  showing the latest rows, with "Mark all read" and "Open inbox".
  Clicking a row marks it read and opens the ticket (board + drawer).
  Also hosts <PushPrompt/>, so wherever the bell lives the first-assignment
  push ask and notification-click routing work.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { Bell, CheckCheck } from 'lucide-svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import Popover from '$lib/ui/Popover.svelte';
  import { markRead } from './actions';
  import { collapse, isSnoozed, rowHref, type Group, type Row } from './inbox';
  import NotificationRow from './NotificationRow.svelte';
  import PushPrompt from './PushPrompt.svelte';
  import { BELL_LIMIT, clock, inboxFeed } from './stores';

  interface Props {
    /** How many rows the dropdown shows. */
    show?: number;
    class?: string;
  }
  let { show = 8, class: cls = '' }: Props = $props();

  const now = clock(60_000);
  const uid = $derived(auth.uid);
  const feed = $derived(inboxFeed(uid, BELL_LIMIT));
  const visible = $derived(($feed.data as Row[]).filter((r) => !isSnoozed(r, $now)));
  const unread = $derived(visible.filter((r) => r.readAt == null));
  const groups = $derived(collapse(visible).slice(0, show));
  const badge = $derived(
    unread.length >= BELL_LIMIT ? `${BELL_LIMIT - 1}+` : String(unread.length),
  );

  let open = $state(false);
  let anchor: HTMLButtonElement | undefined = $state();

  function openRow(g: Group) {
    open = false;
    if (uid && g.unread) void markRead(uid, g.ids);
    void goto(rowHref(g.head));
  }
  function markAll() {
    if (uid)
      void markRead(
        uid,
        unread.map((r) => r.id),
      );
  }
</script>

<button
  bind:this={anchor}
  type="button"
  aria-label={unread.length ? `Notifications, ${unread.length} unread` : 'Notifications'}
  aria-haspopup="dialog"
  aria-expanded={open}
  onclick={() => (open = !open)}
  class="tm-tap relative grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text {cls}"
>
  <Bell size={17} aria-hidden="true" />
  {#if unread.length}
    <span
      class="pointer-events-none absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-accent-fg"
      >{badge}</span
    >
  {/if}
</button>

<Popover
  bind:open
  {anchor}
  placement="bottom-end"
  label="Notifications"
  class="w-[min(26rem,calc(100vw-1rem))] overflow-hidden"
>
  <div class="flex items-center gap-2 border-b border-line px-3 py-2">
    <h2 class="flex-1 text-sm font-semibold">Notifications</h2>
    <Button size="sm" variant="ghost" icon={CheckCheck} disabled={!unread.length} onclick={markAll}
      >Mark all read</Button
    >
  </div>
  <div class="max-h-[60vh] overflow-y-auto" role="listbox" aria-label="Latest notifications">
    {#if $feed.loading}
      <p class="px-4 py-6 text-center text-sm text-muted">Loading…</p>
    {:else if !groups.length}
      <p class="px-4 py-8 text-center text-sm text-muted">You're all caught up.</p>
    {:else}
      {#each groups as g (g.key)}
        <NotificationRow group={g} now={$now} compact onopen={() => openRow(g)} />
      {/each}
    {/if}
  </div>
  <a
    href={routes.inbox()}
    onclick={() => (open = false)}
    class="block border-t border-line px-3 py-2 text-center text-sm font-medium text-accent hover:bg-surface-2"
  >
    Open inbox
  </a>
</Popover>

<PushPrompt />

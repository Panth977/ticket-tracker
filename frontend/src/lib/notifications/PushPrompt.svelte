<!--
  The browser-push ask, shown at the FIRST ASSIGNMENT (an unread 'assigned'
  row in my inbox) and never on a cold page load. Renderless otherwise:
    - refreshes this browser's device doc once a day when push is on
    - routes notification clicks the service worker posts to this tab
  Safe to mount in several places (bell, inbox, my work): only the first
  mounted instance does anything.
-->
<script module lang="ts">
  /** Mounted instances, oldest first; the oldest one is the owner. */
  const mounted = $state<symbol[]>([]);
</script>

<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { BellRing, X } from 'lucide-svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import Button from '$lib/ui/Button.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import { listenForNavigate, push } from './push.svelte';
  import { BELL_LIMIT, inboxFeed } from './stores';

  const me = Symbol('PushPrompt');
  mounted.push(me);
  onDestroy(() => {
    const i = mounted.indexOf(me);
    if (i >= 0) mounted.splice(i, 1);
  });
  const owner = $derived(mounted[0] === me);

  const uid = $derived(auth.uid);
  const feed = $derived(owner ? inboxFeed(uid, BELL_LIMIT) : inboxFeed(null));
  const assignedUnread = $derived(
    $feed.data.some((r) => r.event === 'assigned' && r.readAt == null),
  );

  $effect(() => {
    if (owner && uid) void push.refresh(uid);
  });
  $effect(() => {
    if (owner && assignedUnread) push.ask();
  });
  $effect(() => (owner ? listenForNavigate((url) => void goto(url)) : undefined));

  async function turnOn() {
    if (!uid) return;
    const ok = await push.enable(uid);
    if (ok)
      toast.success(
        'Browser notifications are on',
        'Change what you get in Account › Notifications.',
      );
    else if (push.permission === 'denied')
      toast.info('Notifications are blocked', 'Allow them in your browser’s site settings.');
    else if (push.error) toast.error('Could not turn on notifications', push.error);
  }
</script>

{#if owner && push.asking}
  <div
    role="dialog"
    aria-label="Browser notifications"
    class="fixed right-4 bottom-4 z-[70] w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-4 shadow-pop"
  >
    <div class="flex items-start gap-3">
      <span class="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
        <BellRing size={16} aria-hidden="true" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">You were assigned a ticket</p>
        <p class="mt-0.5 text-xs text-muted">
          Get a browser notification next time, even when this tab is in the background?
        </p>
        <div class="mt-3 flex gap-2">
          <Button size="sm" variant="primary" loading={push.busy} onclick={turnOn}>Turn on</Button>
          <Button size="sm" variant="ghost" onclick={() => push.notNow()}>Not now</Button>
        </div>
      </div>
      <IconButton size="sm" icon={X} label="Dismiss" onclick={() => push.notNow()} />
    </div>
  </div>
{/if}

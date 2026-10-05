<!--
  Every signed-in screen is drawn inside this (app.json › Shell): the Sidebar
  (a ☰ drawer on phones), the command palette, toasts' neighbour 'Saving…',
  and the offline notice. Pages render into the main column.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes or passed in by callers; the SPA has no
  // base path, so resolve() would be the identity.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { Snippet } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { Menu as MenuIcon, WifiOff } from 'lucide-svelte';
  import { saving } from '$lib/api/saving.svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import CommandPalette from '$lib/keyboard/CommandPalette.svelte';
  import { palette } from '$lib/keyboard/palette.svelte';
  import { shortcuts } from '$lib/keyboard/shortcuts';
  import NotificationBell from '$lib/notifications/NotificationBell.svelte';
  import SearchProviders from '$lib/search/SearchProviders.svelte';
  import { myArtifacts } from '$lib/artifacts/store';
  import { myBoards, online } from '$lib/stores';
  import Drawer from '$lib/ui/Drawer.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import Sidebar from './Sidebar.svelte';
  import { registerNavProviders } from './navProviders';
  import { myWorkspaces } from '$lib/workspaces/store';
  import { routes } from './routes';

  let { children }: { children: Snippet } = $props();

  let navOpen = $state(false);
  afterNavigate(() => (navOpen = false));

  const boards = $derived(myBoards(auth.uid));

  const artifacts = $derived(myArtifacts(auth.uid));
  const workspaces = $derived(myWorkspaces(auth.uid));

  $effect(() =>
    registerNavProviders(
      () => boards,
      () => artifacts,
      () => workspaces,
    ),
  );
  $effect(() =>
    shortcuts.bind('mod+k', () => palette.toggle(), {
      inInputs: true,
      description: 'Command palette',
    }),
  );
  // '/' focuses the page's search box ([data-search]) when there is one, else opens the palette.
  $effect(() =>
    shortcuts.bind(
      '/',
      () => {
        const box = document.querySelector<HTMLElement>('[data-search]');
        if (box) box.focus();
        else palette.open();
      },
      { description: 'Search' },
    ),
  );
</script>

<div class="flex min-h-dvh bg-bg">
  <aside
    class="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-line bg-surface md:block"
    aria-label="Sidebar"
  >
    <Sidebar />
  </aside>

  <div class="flex min-w-0 flex-1 flex-col">
    <header
      class="tm-safe-top tm-safe-x sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-line bg-surface px-2 md:hidden"
    >
      <IconButton icon={MenuIcon} label="Open navigation" onclick={() => (navOpen = true)} />
      <a href={routes.home()} class="flex-1 truncate font-semibold">TaskManager</a>
      <NotificationBell />
    </header>

    {#if !$online}
      <div
        role="status"
        class="flex items-center gap-2 bg-warning-soft px-4 py-1.5 text-xs text-warning"
      >
        <WifiOff size={14} aria-hidden="true" /> You're offline — showing saved data. Your changes are
        kept and sync when you reconnect.
      </div>
    {/if}

    <main id="main" class="min-w-0 flex-1">
      {@render children()}
    </main>
  </div>
</div>

<Drawer bind:open={navOpen} side="left" width="min(18rem, 85vw)" label="Navigation">
  <Sidebar />
</Drawer>

<CommandPalette />
<!-- ⌘K 'Tickets' + 'Commands' providers on every screen (ref-counted). -->
<SearchProviders />

{#if saving.active}
  <div
    role="status"
    class="fixed bottom-4 left-4 z-[65] flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted shadow-pop"
  >
    <span class="size-3 animate-spin rounded-full border-2 border-muted border-t-transparent"
    ></span> Saving…
  </div>
{/if}

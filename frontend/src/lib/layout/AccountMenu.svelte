<!--
  Opens from your name at the top of the sidebar — every Account section,
  one click (app.json › Account menu).

  It is also where the PWA lives (agents.html § S): 'Install app' appears here
  and nowhere else — never as a banner over the board — and mounting this menu
  is what starts the install watcher and the "new version is ready" toast,
  since it is on every signed-in screen. On a phone the menu exists twice (the
  sidebar CSS hides and the ☰ drawer), so everything it starts is ref-counted.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes or passed in by callers; the SPA has no
  // base path, so resolve() would be the identity.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ChevronDown, LogOut, Smartphone } from 'lucide-svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { person } from '$lib/people/person';
  import { install, runIntent, startPwa } from '$lib/pwa';
  import { myBoards } from '$lib/stores';
  import Avatar from '$lib/ui/Avatar.svelte';
  import Menu from '$lib/ui/Menu.svelte';
  import type { MenuItem } from '$lib/ui/types';
  import { amIAdmin } from '$lib/account/allow';
  import { accountSections, routes } from './routes';

  const me = $derived(person(auth.uid));
  const name = $derived($me.person?.name ?? auth.profile?.name ?? auth.user?.displayName ?? 'You');
  const email = $derived($me.person?.email ?? auth.user?.email ?? '');

  $effect(() => startPwa());

  // The 'New ticket' app shortcut arrives as ?new=ticket on whatever screen the
  // launcher opened; it needs a board, so it is finished here (lib/pwa/shortcuts).
  const boardsQ = $derived(myBoards(auth.uid));
  $effect(() => {
    void runIntent(new URL(page.url), { list: $boardsQ.data, loading: $boardsQ.loading });
  });

  const items: MenuItem[] = $derived([
    // §X — Users (the admin's module) appears here only for the admin.
    ...accountSections(amIAdmin(auth.user?.email)).map((s) => ({
      label: s.label,
      href: routes.account(s.id),
    })),
    { label: 'Agents', href: routes.agents() },
    ...(install.offer
      ? [
          {
            label: install.kind === 'ios' ? 'Add to Home Screen' : 'Install app',
            icon: Smartphone,
            separator: true,
            onSelect: () => void install.choose(),
          },
        ]
      : []),
    {
      label: 'Sign out',
      icon: LogOut,
      separator: true,
      onSelect: async () => {
        await auth.signOut();
        await goto(routes.login());
      },
    },
  ]);
</script>

<Menu {items} class="w-64">
  {#snippet header()}
    <div class="flex items-center gap-2.5 border-b border-line px-3 pt-2 pb-3 mb-1">
      <Avatar src={$me.person?.avatarUrl} {name} seed={auth.uid ?? ''} size={32} decorative />
      <div class="min-w-0">
        <p class="truncate text-sm font-medium">{name}</p>
        <p class="truncate text-xs text-muted">{email}</p>
      </div>
    </div>
  {/snippet}
  {#snippet trigger(props)}
    <button
      type="button"
      {...props}
      class="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-surface-2"
      aria-label="Account menu"
    >
      <Avatar src={$me.person?.avatarUrl} {name} seed={auth.uid ?? ''} size={22} decorative />
      <span class="flex-1 truncate text-sm font-medium">{name}</span>
      <ChevronDown size={14} class="text-muted" aria-hidden="true" />
    </button>
  {/snippet}
</Menu>

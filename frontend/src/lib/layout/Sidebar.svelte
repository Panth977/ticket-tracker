<!--
  THE ONE NAVIGATION (app.json › Sidebar; agents.html §Q1). A flat list — no
  accordions, nothing two levels deep:
    (picture) Name ▾ · ⌘K Search · Inbox n · My work · Invitations n (only while pending)
    — Orgs:  ▸ ● Name [+]          ← /{handle}; ▸ unfolds its boards, artifacts, buckets (§AC)
    — Users: ▸ ◯ Me (you) [+]      ← my own space, then each person who shares things with me
        ● KEY Name •n              ← one click = that board's default view
        ↳ Analytics                ← under the OPEN board only (agents.html §Y3)
      Nothing is listed outside its owner: no root lists, no hiding (like GitHub).
    — You: Agents · Notifications · Tokens · Sign out   (Agents: agents.html §B)
  Views, People and Settings are NOT here: they are on the board page, behind
  the view tabs and ⚙ Settings (§Q2).
  On a phone the Shell puts this in a drawer behind ☰.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes or passed in by callers; the SPA has no
  // base path, so resolve() would be the identity.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Bell, Bot, Inbox, KeyRound, LogOut, Mail, Search, SquareCheck } from 'lucide-svelte';
  import { derived, readable } from 'svelte/store';
  import { SvelteMap } from 'svelte/reactivity';
  import type { BoardPref } from '@tm/shared';
  import { auth } from '$lib/firebase/auth.svelte';
  import { palette } from '$lib/keyboard/palette.svelte';
  import { boardPref, inboxUnread, myBoards, myInvites } from '$lib/stores';
  import Kbd from '$lib/ui/Kbd.svelte';
  import NotificationBell from '$lib/notifications/NotificationBell.svelte';
  import AccountMenu from './AccountMenu.svelte';
  import NavItem from './NavItem.svelte';
  import SyncStatus from './SyncStatus.svelte';
  import { routes } from './routes';
  import { agentRoutes } from '$lib/agents/routes';
  import { myArtifacts, splitArtifacts } from '$lib/artifacts/store';
  import { myBuckets, splitBuckets } from '$lib/bucket/store';
  import { myDictionaries, splitDictionaries } from '$lib/dictionary/store';
  import { myOrgs } from '$lib/orgs/store';
  import { ownerGroups } from '$lib/orgs/owners';
  import { parseThingPath } from '$lib/orgs/path';
  import SidebarOwners from './SidebarOwners.svelte';

  const uid = $derived(auth.uid);
  const boardsQ = $derived(myBoards(uid));
  const inboxQ = $derived(inboxUnread(uid));
  const invitesQ = $derived(myInvites(auth.user?.emailVerified ? auth.user.email : null));

  const active = $derived($boardsQ.data.filter((b) => b.archivedAt == null));
  // One prefs doc per board I am on: it carries both the star (ordering) and
  // lastViewId (where a click lands).
  const prefsQ = $derived(
    uid && active.length
      ? derived(
          active.map((b) => boardPref(b.id, uid)),
          (list) => new Map(list.map((p, i) => [active[i]!.id, p.data ?? null])),
        )
      : readable(new Map<string, BoardPref | null>()),
  );
  const unreadByBoard = $derived.by(() => {
    const m = new SvelteMap<string, number>();
    for (const n of $inboxQ.data) m.set(n.boardId, (m.get(n.boardId) ?? 0) + 1);
    return m;
  });
  const inboxCount = $derived($inboxQ.data.length);
  const inviteCount = $derived($invitesQ.data.length);

  // Artifacts, buckets and dictionaries I have a role on. Archived ones are on their owner's page only.
  const artifactsQ = $derived(myArtifacts(uid));
  const artifacts = $derived(splitArtifacts($artifactsQ.data).active);
  const bucketsQ = $derived(myBuckets(uid));
  const buckets = $derived(splitBuckets($bucketsQ.data).active);
  const dictionariesQ = $derived(myDictionaries(uid));
  const dictionaries = $derived(splitDictionaries($dictionariesQ.data).active);

  const path: string = $derived(page.url.pathname);
  // /b/KEY or /{handle}/b/KEY (§AC); an artifact / bucket by id or by slug.
  const at = $derived(parseThingPath(path));
  const currentArtifact = $derived(at?.kind === 'artifact' ? at.ref : null);
  const currentKey = $derived(at?.kind === 'board' ? at.ref.toUpperCase() : null);
  const currentBucket = $derived(at?.kind === 'bucket' ? at.ref : null);
  const currentDictionary = $derived(at?.kind === 'dictionary' ? at.ref : null);

  // Everything under its owner (§AC): my orgs, then me and the people who share with me.
  const orgsQ = $derived(myOrgs(uid));
  const groups = $derived(
    ownerGroups({
      me: uid ?? '',
      myHandle: auth.profile?.handle,
      orgs: $orgsQ.data,
      boards: active,
      artifacts,
      buckets,
      dictionaries,
    }),
  );

  async function signOut() {
    await auth.signOut();
    await goto(routes.login());
  }
</script>

<nav aria-label="Main" class="flex h-full flex-col gap-4 overflow-y-auto px-2 py-3 text-sm">
  <div class="flex flex-col gap-px">
    <div class="flex items-center gap-1">
      <div class="min-w-0 flex-1"><AccountMenu /></div>
      <NotificationBell />
    </div>
    <NavItem icon={Search} onclick={() => palette.open()}>
      Search
      {#snippet trailing()}<Kbd keys="mod+k" class="opacity-70" />{/snippet}
    </NavItem>
    <NavItem href={routes.inbox()} icon={Inbox} count={inboxCount} active={path === '/inbox'}
      >Inbox</NavItem
    >
    <NavItem href={routes.myWork()} icon={SquareCheck} active={path === '/me'}>My work</NavItem>
    {#if inviteCount}
      <NavItem href={routes.invitations()} icon={Mail} count={inviteCount}>Invitations</NavItem>
    {/if}
  </div>

  {#if $boardsQ.error}
    <p class="px-2 text-xs text-danger">Couldn't load boards.</p>
  {/if}
  <SidebarOwners
    title="Orgs"
    groups={groups.orgs}
    prefs={$prefsQ}
    unread={unreadByBoard}
    {path}
    {currentKey}
    {currentArtifact}
    {currentBucket}
    {currentDictionary}
    onNewOrg={() => goto(routes.newOrg())}
  />
  <SidebarOwners
    title="Users"
    groups={groups.users}
    prefs={$prefsQ}
    unread={unreadByBoard}
    {path}
    {currentKey}
    {currentArtifact}
    {currentBucket}
    {currentDictionary}
  />

  <div class="mt-auto flex flex-col gap-px border-t border-line pt-3">
    <h2 class="px-2 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">You</h2>
    <NavItem
      href={agentRoutes.list()}
      icon={Bot}
      active={path === '/agents' || path.startsWith('/agents/')}>Agents</NavItem
    >
    <NavItem
      href={routes.account('notifications')}
      icon={Bell}
      active={path === '/account/notifications'}
    >
      Notifications
    </NavItem>
    <NavItem href={routes.account('tokens')} icon={KeyRound} active={path === '/account/tokens'}
      >Tokens</NavItem
    >
    <NavItem icon={LogOut} onclick={signOut}>Sign out</NavItem>
    <!-- The outbox: 'Syncing · n' / '⚠ n failed' (agents.html § K). -->
    <div class="pt-1"><SyncStatus /></div>
  </div>
</nav>

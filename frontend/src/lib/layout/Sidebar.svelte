<!--
  THE ONE NAVIGATION (app.json › Sidebar; agents.html §Q1). A flat list — no
  accordions, nothing two levels deep:
    (picture) Name ▾ · ⌘K Search · Inbox n · My work · Invitations n (only while pending)
    — Orgs: ▸ ● Name                ← /{handle}; ▸ unfolds what it owns (agents.html §AC)
    — Boards: ● KEY Name •n        ← one click = that board's default view (minus hidden ones)
        ↳ Analytics                ← under the OPEN board only (agents.html §Y3)
      All boards & archived · + New board
    — Artifacts: ◆ Name            ← one click = that artifact (artifacts.html §F)
      All artifacts · + New artifact
    — Bucket: 🧠 Name             ← one click = that bucket (bucket.html §F)
      All bucket · + New bucket
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
  import {
    AppWindow,
    Bell,
    Bot,
    Brain,
    Inbox,
    KeyRound,
    LayoutGrid,
    LogOut,
    Mail,
    Plus,
    Search,
    SquareCheck,
  } from 'lucide-svelte';
  import { derived, readable } from 'svelte/store';
  import { SvelteMap } from 'svelte/reactivity';
  import type { BoardPref } from '@tm/shared';
  import { auth } from '$lib/firebase/auth.svelte';
  import { palette } from '$lib/keyboard/palette.svelte';
  import { boardPref, inboxUnread, myBoards, myInvites } from '$lib/stores';
  import Kbd from '$lib/ui/Kbd.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import NotificationBell from '$lib/notifications/NotificationBell.svelte';
  import AccountMenu from './AccountMenu.svelte';
  import NavItem from './NavItem.svelte';
  import SidebarBoard from './SidebarBoard.svelte';
  import SyncStatus from './SyncStatus.svelte';
  import { routes } from './routes';
  import { agentRoutes } from '$lib/agents/routes';
  import NewArtifactDialog from '$lib/artifacts/NewArtifactDialog.svelte';
  import { myArtifacts, splitArtifacts } from '$lib/artifacts/store';
  import Indicator from '$lib/ui/Indicator.svelte';
  import { BUCKET_DEFAULT_INDICATOR } from '@tm/shared';
  import NewBucketDialog from '$lib/bucket/NewBucketDialog.svelte';
  import { myBuckets, splitBuckets } from '$lib/bucket/store';
  import { hiddenItems } from '$lib/layout/hidden';
  import { inOrgs, myOrgs } from '$lib/orgs/store';
  import { parseThingPath } from '$lib/orgs/path';
  import SidebarOrgs from './SidebarOrgs.svelte';

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
  const sorted = $derived(
    [...active].sort(
      (a, b) =>
        Number($prefsQ.get(b.id)?.starred ?? false) - Number($prefsQ.get(a.id)?.starred ?? false) ||
        a.name.localeCompare(b.name),
    ),
  );
  const unreadByBoard = $derived.by(() => {
    const m = new SvelteMap<string, number>();
    for (const n of $inboxQ.data) m.set(n.boardId, (m.get(n.boardId) ?? 0) + 1);
    return m;
  });
  const inboxCount = $derived($inboxQ.data.length);
  const inviteCount = $derived($invitesQ.data.length);

  // Artifacts I have a role on. Archived ones live on the All artifacts page only.
  const artifactsQ = $derived(myArtifacts(uid));
  const artifacts = $derived(splitArtifacts($artifactsQ.data).active);
  let newArtifact = $state(false);
  // Buckets I have a role on (bucket.html §F); archived ones on All bucket only.
  const bucketsQ = $derived(myBuckets(uid));
  const buckets = $derived(splitBuckets($bucketsQ.data).active);
  let newBucket = $state(false);

  const path: string = $derived(page.url.pathname);
  // /b/KEY or /{handle}/b/KEY (§AC); an artifact / bucket by id or by slug.
  const at = $derived(parseThingPath(path));
  const currentArtifact = $derived(at?.kind === 'artifact' ? at.ref : null);
  const currentKey = $derived(at?.kind === 'board' ? at.ref.toUpperCase() : null);
  const currentBucket = $derived(at?.kind === 'bucket' ? at.ref : null);

  // The root lists leave out what I hid, and what an org of mine owns (it is under the org, §AC).
  const hiddenQ = $derived(hiddenItems(uid));
  const orgsQ = $derived(myOrgs(uid));
  const rootBoards = $derived(
    sorted.filter((b) => !$hiddenQ.boards.has(b.id) && !inOrgs(b, $orgsQ.data)),
  );
  const rootArtifacts = $derived(
    artifacts.filter((a) => !$hiddenQ.artifacts.has(a.id) && !inOrgs(a, $orgsQ.data)),
  );
  const rootBuckets = $derived(
    buckets.filter((m) => !$hiddenQ.buckets.has(m.id) && !inOrgs(m, $orgsQ.data)),
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

  <SidebarOrgs
    boards={active}
    {artifacts}
    {buckets}
    prefs={$prefsQ}
    unread={unreadByBoard}
    {path}
    {currentKey}
    {currentArtifact}
    {currentBucket}
  />

  <div class="flex flex-col gap-px">
    <h2 class="px-2 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">Boards</h2>
    {#if $boardsQ.loading}
      <div class="flex flex-col gap-2 px-2 py-1">
        <Skeleton width="80%" /><Skeleton width="60%" />
      </div>
    {:else if $boardsQ.error}
      <p class="px-2 text-xs text-danger">Couldn't load boards.</p>
    {:else}
      {#each rootBoards as b (b.id)}
        <SidebarBoard
          board={b}
          starred={$prefsQ.get(b.id)?.starred ?? false}
          unread={unreadByBoard.get(b.id) ?? 0}
          current={b.key === currentKey}
          lastViewId={$prefsQ.get(b.id)?.lastViewId ?? null}
        />
      {/each}
    {/if}
    <NavItem href={routes.home()} icon={LayoutGrid} active={path === '/'}
      >All boards & archived</NavItem
    >
    <NavItem href={routes.newBoard()} icon={Plus}>New board</NavItem>
  </div>

  <div class="flex flex-col gap-px">
    <h2 class="px-2 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">
      Artifacts
    </h2>
    {#if $artifactsQ.loading}
      <div class="px-2 py-1"><Skeleton width="70%" /></div>
    {:else if $artifactsQ.error}
      <p class="px-2 text-xs text-danger">Couldn't load artifacts.</p>
    {:else}
      {#each rootArtifacts as a (a.id)}
        {@const current = a.id === currentArtifact || a.slug === currentArtifact}
        <a
          href={routes.artifact(a.id)}
          aria-current={current ? 'page' : undefined}
          data-artifact={a.id}
          class="flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-sm
            {current
            ? 'bg-surface-3 font-medium text-text'
            : 'text-muted hover:bg-surface-2 hover:text-text'}"
        >
          <Indicator of={a} seed={a.id} size="sm" />
          <span class="flex-1 truncate">{a.name}</span>
        </a>
      {/each}
    {/if}
    <NavItem href={routes.artifacts()} icon={AppWindow} active={path === '/x'}
      >All artifacts</NavItem
    >
    <NavItem icon={Plus} onclick={() => (newArtifact = true)}>New artifact</NavItem>
  </div>

  <div class="flex flex-col gap-px">
    <h2 class="px-2 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">Bucket</h2>
    {#if $bucketsQ.loading}
      <div class="px-2 py-1"><Skeleton width="60%" /></div>
    {:else if $bucketsQ.error}
      <p class="px-2 text-xs text-danger">Couldn't load bucket.</p>
    {:else}
      {#each rootBuckets as m (m.id)}
        {@const current = m.id === currentBucket || m.slug === currentBucket}
        <a
          href={routes.bucket(m.id)}
          aria-current={current ? 'page' : undefined}
          data-bucket={m.id}
          class="flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-sm
            {current
            ? 'bg-surface-3 font-medium text-text'
            : 'text-muted hover:bg-surface-2 hover:text-text'}"
        >
          <Indicator of={m} seed={m.id} fallback={BUCKET_DEFAULT_INDICATOR} size="sm" />
          <span class="flex-1 truncate">{m.name}</span>
        </a>
      {/each}
    {/if}
    <NavItem href={routes.buckets()} icon={Brain} active={path === '/bucket'}>All bucket</NavItem>
    <NavItem icon={Plus} onclick={() => (newBucket = true)}>New bucket</NavItem>
  </div>

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

<NewArtifactDialog bind:open={newArtifact} />
<NewBucketDialog bind:open={newBucket} />

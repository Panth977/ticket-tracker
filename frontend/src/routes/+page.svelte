<!--
  Boards (app.json › Boards) — home. Invitations first, then every board you
  are on (where readerUids array-contains me — every board you created or
  accepted, and nothing else), starred first, then the archived ones.
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { derived, readable } from 'svelte/store';
  import { Archive, LayoutGrid, Plus } from 'lucide-svelte';
  import { command } from '$lib/api';
  import BoardTile from '$lib/account/BoardTile.svelte';
  import InviteCard from '$lib/account/InviteCard.svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { boardPref, myBoards, myInvites } from '$lib/stores';
  import { Button, EmptyState, Skeleton, toast } from '$lib/ui';
  import { dateOnly } from '$lib/account/format';

  const uid = $derived(auth.uid);
  const boardsQ = $derived(myBoards(uid));
  const invitesQ = $derived(myInvites(auth.user?.emailVerified ? auth.user.email : null));
  const invites = $derived($invitesQ.data.filter((i) => i.expiresAt > Date.now()));

  const active = $derived($boardsQ.data.filter((b) => b.archivedAt == null));
  const archived = $derived(
    $boardsQ.data
      .filter((b) => b.archivedAt != null)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
  );
  // Starred first (the same order as the sidebar), then by name.
  const starredQ = $derived(
    uid && active.length
      ? derived(
          active.map((b) => boardPref(b.id, uid)),
          (list) => new Set(list.flatMap((p, i) => (p.data?.starred ? [active[i]!.id] : []))),
        )
      : readable(new Set<string>()),
  );
  const sorted = $derived(
    [...active].sort(
      (a, b) =>
        Number($starredQ.has(b.id)) - Number($starredQ.has(a.id)) || a.name.localeCompare(b.name),
    ),
  );

  let restoring = $state<string | null>(null);
  async function restore(boardId: string, name: string) {
    restoring = boardId;
    try {
      await command(
        'boardArchive',
        { boardId, action: 'restore' },
        { toast: 'Could not restore the board' },
      );
      toast.success(`${name} is back`);
    } catch {
      /* toasted */
    } finally {
      restoring = null;
    }
  }
</script>

<svelte:head><title>Boards · TaskManager</title></svelte:head>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8">
  <header class="flex items-center justify-between gap-4">
    <h1 class="text-2xl font-semibold">Boards</h1>
    <Button variant="primary" icon={Plus} href={routes.newBoard()}>New board</Button>
  </header>

  {#if invites.length}
    <section class="flex flex-col gap-2" aria-labelledby="inv-h">
      <h2 id="inv-h" class="text-sm font-semibold text-muted">Invitations</h2>
      {#each invites as inv (inv.id)}
        <InviteCard invite={inv} />
      {/each}
    </section>
  {/if}

  <section aria-label="Your boards">
    {#if $boardsQ.loading}
      <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {#each [1, 2, 3] as i (i)}<Skeleton height="7rem" class="rounded-xl" />{/each}
      </div>
    {:else if $boardsQ.error}
      <p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
        Couldn’t load your boards.
      </p>
    {:else if !active.length && !invites.length}
      <EmptyState
        icon={LayoutGrid}
        title="No boards yet"
        description="Create a board for your team — or ask someone to invite you to theirs."
      >
        {#snippet action()}<Button variant="primary" icon={Plus} href={routes.newBoard()}
            >Create a board</Button
          >{/snippet}
      </EmptyState>
    {:else}
      <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {#each sorted as b (b.id)}
          <BoardTile board={b} uid={uid ?? ''} />
        {/each}
        <a
          href={routes.newBoard()}
          class="flex min-h-28 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line-strong text-sm text-muted transition-colors hover:border-accent hover:text-accent"
        >
          <Plus size={18} aria-hidden="true" /> New board
        </a>
      </div>
    {/if}
  </section>

  {#if archived.length}
    <details class="group rounded-xl border border-line bg-surface">
      <summary
        class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted select-none"
      >
        <Archive size={16} aria-hidden="true" /> Archived boards
        <span class="text-subtle">({archived.length})</span>
      </summary>
      <ul class="divide-y divide-line border-t border-line">
        {#each archived as b (b.id)}
          <li class="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <span class="font-mono text-xs text-muted">{b.key}</span>
            <a class="flex-1 truncate text-sm hover:underline" href={routes.board(b.key)}
              >{b.name}</a
            >
            <span class="text-xs text-subtle"
              >archived {dateOnly(b.archivedAt ?? 0, auth.profile?.timezone)}</span
            >
            {#if uid && b.access[uid] === 'admin'}
              <Button
                size="sm"
                variant="ghost"
                loading={restoring === b.id}
                onclick={() => restore(b.id, b.name)}
              >
                Restore
              </Button>
            {/if}
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</div>

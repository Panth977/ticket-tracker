<!--
  /b/[boardKey] — open the view I was last on (prefs/{me}.lastViewId), else
  the board's default view. Keeps ?ticket= so '#ENG-42' links land with the
  drawer open.
-->
<script lang="ts">
  // goto() targets are built by lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { auth } from '$lib/firebase/auth.svelte';
  import { boardByKey, boardPref, boardViews } from '$lib/stores';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';

  const board = $derived(boardByKey(auth.uid, page.params.boardKey));
  const id = $derived($board.board?.id ?? null);
  const pref = $derived(boardPref(id, auth.uid));
  const views = $derived(boardViews(id, auth.uid));

  $effect(() => {
    const b = $board.board;
    if (!b || $pref.loading || $views.loading) return;
    const last = $pref.data?.lastViewId;
    const target = last && $views.data.some((v) => v.id === last) ? last : b.defaultViewId;
    void goto(routes.board(b.key, target, page.url.searchParams.get('ticket')), {
      replaceState: true,
    });
  });
</script>

{#if !$board.loading && !$board.board}
  <EmptyState
    title="Board not found"
    description="It may have been deleted, or you're not on it. Ask an admin for an invite."
  >
    {#snippet action()}<Button href={routes.home()}>Back to your boards</Button>{/snippet}
  </EmptyState>
{:else}
  <div class="flex flex-col gap-3 p-6">
    <Skeleton height="1.5rem" width="16rem" /><Skeleton lines={4} />
  </div>
{/if}

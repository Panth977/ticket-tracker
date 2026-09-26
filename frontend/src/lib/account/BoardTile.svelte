<!--
  A board on the Boards home: colour, key, name, counts, and a star (your
  own boards/{b}/prefs/{me}.starred — pinned to the top here and in the sidebar).
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { Star } from 'lucide-svelte';
  import { paths, type Board } from '@tm/shared';
  import { command } from '$lib/api';
  import { routes } from '$lib/layout/routes';
  import { boardPref, type WithId } from '$lib/stores';
  import { fmtTurns, fmtUsd, fmtUsdExact } from '$lib/cost/format';

  interface Props {
    board: WithId<Board>;
    uid: string;
  }
  let { board, uid }: Props = $props();

  const pref = $derived(boardPref(board.id, uid));
  const starred = $derived($pref.data?.starred ?? false);
  const href = $derived(routes.board(board.key, $pref.data?.lastViewId || null));

  async function toggleStar(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const next = !starred;
    try {
      await command(
        'boardPrefSet',
        { boardId: board.id, pref: { starred: next } },
        {
          optimistic: { path: paths.pref(board.id, uid), patch: { starred: next } },
          toast: 'Could not update the star',
        },
      );
    } catch {
      /* rolled back + toasted */
    }
  }
</script>

<a
  {href}
  class="group relative flex min-h-28 flex-col gap-2 overflow-hidden rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
  data-board={board.key}
>
  <span class="absolute inset-y-0 left-0 w-1" style:background={board.color} aria-hidden="true"
  ></span>
  <div class="flex items-start gap-2">
    <span
      class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs font-semibold text-muted group-hover:bg-surface-3"
    >
      {board.key}
    </span>
    <span class="flex-1"></span>
    <button
      type="button"
      class="-m-1 rounded p-1 transition-colors {starred
        ? 'text-warning'
        : 'text-subtle opacity-0 group-hover:opacity-100 focus-visible:opacity-100'} hover:text-warning"
      aria-label={starred ? `Unstar ${board.name}` : `Star ${board.name}`}
      aria-pressed={starred}
      onclick={toggleStar}
    >
      <Star size={16} fill={starred ? 'currentColor' : 'none'} aria-hidden="true" />
    </button>
  </div>
  <h3 class="line-clamp-2 font-medium">{board.name}</h3>
  <p class="mt-auto flex gap-3 text-xs text-muted">
    <span>{board.counts.active} open</span>
    {#if board.counts.overdue}<span class="text-danger">{board.counts.overdue} overdue</span>{/if}
    <span
      >{Object.keys(board.access).length}
      {Object.keys(board.access).length === 1 ? 'person' : 'people'}</span
    >
  </p>
  {#if board.cost && board.cost.usd > 0}
    <!-- Phase 17 (§Y2): what the agents' turns on this board have cost, for its lifetime. -->
    <p
      class="text-xs text-subtle tabular-nums"
      data-cost
      title="{fmtUsdExact(board.cost.usd)} over {fmtTurns(board.cost.runs)}"
    >
      {fmtUsd(board.cost.usd)} in agent turns · {fmtTurns(board.cost.runs)}
    </p>
  {/if}
</a>

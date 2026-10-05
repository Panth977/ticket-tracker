<!--
  One board in the sidebar (agents.html §Q1): a single row — its indicator, key,
  name, unread count. No accordion: clicking it opens the view I was last on
  (prefs.lastViewId), falling back to the board's default view. Views, People
  and Settings live on the board page now.
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path, so resolve() would be the identity.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { Star } from 'lucide-svelte';
  import type { Board } from '@tm/shared';
  import type { WithId } from '$lib/stores';
  import Indicator from '$lib/ui/Indicator.svelte';
  import { routes } from './routes';

  interface Props {
    board: WithId<Board>;
    starred: boolean;
    unread: number;
    /** The board being looked at — highlighted. */
    current: boolean;
    /** prefs.lastViewId, when I have one that still exists. */
    lastViewId?: string | null;
    /** §AB: under a workspace in the sidebar. */
    indent?: boolean;
    /** §AB: entering (or leaving) a workspace context on the way. */
    onclick?: () => void;
  }
  let {
    board,
    starred,
    unread,
    current,
    lastViewId = null,
    indent = false,
    onclick,
  }: Props = $props();

  // One click = the default view. Linking straight at it skips the /b/KEY
  // redirect hop; a lastViewId whose view has since been deleted still lands
  // (the board route sends it on to the default view).
  const href = $derived(routes.board(board.key, lastViewId || board.defaultViewId));
</script>

<a
  {href}
  {onclick}
  aria-current={current ? 'page' : undefined}
  data-board={board.key}
  class="flex h-7 min-w-0 items-center gap-2 rounded-md text-sm {indent ? 'pr-2 pl-7' : 'px-2'}
    {current
    ? 'bg-surface-3 font-medium text-text'
    : 'text-muted hover:bg-surface-2 hover:text-text'}"
>
  <Indicator of={board} seed={board.id} size="sm" />
  <span class="text-[11px] font-semibold tracking-wide text-subtle">{board.key}</span>
  <span class="flex-1 truncate">{board.name}</span>
  {#if starred}<Star
      size={12}
      class="shrink-0 fill-current text-warning"
      aria-label="Starred"
    />{/if}
  {#if unread}<span class="flex items-center gap-1 text-xs text-accent" aria-label="{unread} unread"
      ><span class="size-1.5 rounded-full bg-accent"></span>{unread}</span
    >{/if}
</a>

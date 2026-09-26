<!--
  Activity (the right pane's last section): every change, newest first, in
  words (activity.ts humanize) with the actor and a 'via email / API / MCP'
  badge. More loads as the pane scrolls to the end.

  Unread (agents.html § K): entries newer than my read pointer as it was when
  the ticket opened sit under a 'New' divider — unless I made them.
-->
<script lang="ts">
  import { History } from 'lucide-svelte';
  import { Badge, EmptyState, Skeleton } from '$lib/ui';
  import { myBoards } from '$lib/stores';
  import { auth } from '$lib/firebase/auth.svelte';
  import { getTicketCtx } from './context';
  import { activityFeed } from './data';
  import { humanize, viaLabel, type ActivityLookups } from './activity';
  import PersonAvatar from './PersonAvatar.svelte';
  import { formatWhen, formatDay } from './time';

  const PAGE = 50;
  const t = getTicketCtx();
  let count = $state(PAGE);
  const feed = $derived(activityFeed(t.boardId, t.ticketId, count));
  const boards = $derived(myBoards(auth.uid));

  const L: ActivityLookups = {
    stage: (id) => t.board.stages.find((s) => s.id === id)?.name,
    priority: (id) => t.board.priorities.find((s) => s.id === id)?.name,
    tag: (id) => t.board.tags.find((s) => s.id === id)?.name,
    person: (uid) => t.members.find((m) => m.uid === uid)?.name,
    field: (id) => t.board.fields.find((f) => f.id === id),
    ticket: () => undefined,
    board: (id) => $boards.data.find((b) => b.id === id)?.name,
    date: (ms, allDay) => formatDay(ms, t.tz, allDay),
  };
  // Keep showing the last page while the next one loads (no flash back to a skeleton).
  let last = $state<typeof $feed.data>([]);
  $effect(() => {
    if (!$feed.loading) last = $feed.data;
  });
  const data = $derived($feed.loading ? last : $feed.data);
  const rows = $derived(data.map((a) => ({ a, lines: humanize(a, L) })));
  const more = $derived(!$feed.loading && $feed.data.length >= count);

  /** Rows above this index are new to me (newest first, so they are a prefix). */
  const newCount = $derived.by(() => {
    const since = t.readSince;
    if (since == null) return 0;
    const i = data.findIndex((a) => a.createdAt <= since);
    const n = i === -1 ? data.length : i;
    // Only my own changes? Nothing is new.
    return data.slice(0, n).some((a) => a.actor !== t.me) ? n : 0;
  });

  let sentinel: HTMLElement | undefined = $state();
  $effect(() => {
    if (!sentinel || !more || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) count += PAGE;
    });
    io.observe(sentinel);
    return () => io.disconnect();
  });
</script>

{#snippet divider(label: string)}
  <li
    class="-ml-4 flex items-center gap-2 py-0.5 text-[11px] font-semibold tracking-wide text-danger uppercase"
    role="separator"
    aria-label={label}
  >
    <span class="h-px w-3 bg-danger/50"></span>{label}<span class="h-px flex-1 bg-danger/40"></span>
  </li>
{/snippet}

{#if $feed.loading && !last.length}
  <div class="flex flex-col gap-3" aria-busy="true" aria-label="Loading activity">
    {#each [0, 1, 2] as i (i)}
      <div class="flex items-start gap-2">
        <Skeleton width="18px" height="18px" class="rounded-full" />
        <div class="flex flex-1 flex-col gap-1.5">
          <Skeleton width="85%" /><Skeleton width="40%" height="0.7rem" />
        </div>
      </div>
    {/each}
  </div>
{:else if !rows.length}
  <EmptyState icon={History} title="No activity yet" />
{:else}
  <ol class="relative ml-2 flex flex-col gap-3 border-l border-line pl-4">
    {#if newCount}{@render divider('New')}{/if}
    {#each rows as { a, lines }, i (a.id)}
      {#if newCount && i === newCount}
        <li class="-ml-4 h-px bg-line" role="separator" aria-label="Earlier"></li>
      {/if}
      <li class="relative text-sm">
        <span class="absolute top-0.5 -left-[1.6rem]">
          {#if a.actor}<PersonAvatar uid={a.actor} size={18} ring />{:else}<span
              class="block size-[18px] rounded-full bg-surface-3 ring-2 ring-surface"
            ></span>{/if}
        </span>
        <div class="flex flex-wrap items-baseline gap-x-1.5">
          <span class="font-medium"
            >{a.actor
              ? (t.members.find((m) => m.uid === a.actor)?.name ?? 'Someone')
              : 'System'}</span
          >
          <span>{lines[0]}</span>
          {#if viaLabel(a.via)}<Badge>{viaLabel(a.via)}</Badge>{/if}
          {#if a.viaGrant?.length}<Badge tone="accent">stage grant</Badge>{/if}
          <time class="text-xs text-subtle" datetime={new Date(a.createdAt).toISOString()}
            >{formatWhen(a.createdAt, t.tz)}</time
          >
        </div>
        {#if lines.length > 1}
          <ul class="mt-0.5 list-disc pl-5 text-muted">
            {#each lines.slice(1) as l, j (j)}<li>{l}</li>{/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ol>
  {#if more}
    <div bind:this={sentinel} class="mt-3 flex flex-col gap-2" aria-hidden="true">
      <Skeleton width="70%" /><Skeleton width="50%" />
    </div>
  {/if}
{/if}

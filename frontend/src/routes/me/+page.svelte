<!--
  My work (app.json › My work, route /me):
    tiles  Overdue · Due today · This week · Committed        (?tile=, click again to clear)
    chips  Assigned to me · Created by me · Watching           (?scope=)
    table  Key · Title · Board · Stage · Due · Commitment
  One collection-group query across every board (see ./myWork.ts). 'Mentioned
  me' is the Inbox's Mentions tab — mentions live on messages, not tickets.
  A row opens the ticket drawer beside the table (?ticket=KEY); the
  Commitment cell sets MY pickup date via ticketUpdate { commitments }.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Indicator from '$lib/ui/Indicator.svelte';
  import { AlarmClock, CalendarCheck, CalendarDays, CircleAlert, SquareCheck } from 'lucide-svelte';
  import { paths, type Board, type Read } from '@tm/shared';
  import { can } from '@tm/shared/logic/can';
  import { dayRange } from '@tm/shared/logic/time';
  import { outbox } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import PushPrompt from '$lib/notifications/PushPrompt.svelte';
  import { clock } from '$lib/notifications/stores';
  import SearchProviders from '$lib/search/SearchProviders.svelte';
  import { questionSignalOfTicket, tasklistSignalOfTicket } from '$lib/board/signals';
  import { isBlocked, isUnread, unreadTracked } from '$lib/board/summary';
  import TicketSummary from '$lib/board/TicketSummary.svelte';
  import { myBoards, queryStore } from '$lib/stores';
  import TicketDrawer from '$lib/ticket/TicketDrawer.svelte';
  import type { IconComponent } from '$lib/ui/types';
  import DatePicker from '$lib/ui/DatePicker.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import Tabs from '$lib/ui/Tabs.svelte';
  import { groupTickets } from './groupTickets';
  import { memberChoicesAcross } from './people';
  import {
    isOpenWork,
    overdue,
    parseScope,
    parseTile,
    SCOPES,
    scopeQuery,
    tileCounts,
    TILES,
    visibleWork,
    type MyTicket,
    type Tile,
  } from './myWork';

  const now = clock(60_000);
  const uid = $derived(auth.uid);
  const tz = $derived(auth.profile?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);

  const scope = $derived(parseScope(page.url.searchParams.get('scope')));
  const tile = $derived(parseTile(page.url.searchParams.get('tile')));
  const ticketKey = $derived(page.url.searchParams.get('ticket'));

  const q = $derived(groupTickets(uid ? scopeQuery(scope, uid) : null));
  const boardsQ = $derived(myBoards(uid));
  const boards = $derived(new Map($boardsQ.data.map((b) => [b.id, b])));

  const list = $derived($q.data as MyTicket[]);
  const open = $derived(list.filter(isOpenWork));
  const counts = $derived(
    uid ? tileCounts(open, uid, $now, tz) : { overdue: 0, today: 0, week: 0, committed: 0 },
  );
  const rows = $derived(uid ? visibleWork(list, tile, uid, $now, tz) : []);
  /** The boards these rows come from — pickers and names are joined per board. */
  const rowBoards = $derived([...new Set(rows.map((r) => r.boardId))].sort());
  // §L1 · §W: ❓ Waiting for you comes off the ticket document itself now —
  // the board-wide collection-group question listener is gone.

  // Phase 8 (§P2): the rows draw the SAME summary the board card does, so the
  // two never disagree about what a ticket is saying. Two things the board
  // gets from its BoardState have to be built here instead:
  //   · my read pointers — one listener over users/{me}/reads, the same
  //     documents the thread's 'New messages' divider uses, so opening a
  //     ticket clears its 💬 badge here too;
  //   · 'is this blocked', which needs the other tickets — we only have the
  //     ones on this screen, and a blocker we cannot see still counts.
  const readsQ = $derived(queryStore<Read>(uid ? { path: paths.reads(uid) } : null));
  const readAt = $derived(new Map($readsQ.data.map((r) => [r.id, r.readAt])));
  const byId = $derived(new Map(rows.map((t) => [t.id, t])));
  /** Cap the unread COUNT queries, exactly as a board does. */
  const counted = $derived(unreadTracked(rows, (id) => readAt.get(id), uid ?? '', 40));
  /** The assignee picker's people and agents, per board these rows came from. */
  const choicesQ = $derived(memberChoicesAcross(rowBoards));

  /** §P2: 'read-only unless you may edit' — a viewer sees avatars, no picker. */
  function canAssign(t: MyTicket, b: Board): boolean {
    if (!uid || b.archivedAt != null) return false;
    // `boards` is keyed by board id, so the row's boardId IS this board's id.
    return can({ actor: uid }, { ...b, id: t.boardId }, 'assign', t);
  }
  function setAssignees(t: MyTicket, uids: string[]) {
    outbox.queue(
      'ticketUpdate',
      { boardId: t.boardId, ticketId: t.id, patch: { assigneeUids: uids } },
      {
        kind: 'ticket',
        label: `change who has ${t.key}`,
        openTo: href((p) => p.set('ticket', t.key)),
        optimistic: { path: paths.ticket(t.boardId, t.id), patch: { assigneeUids: uids } },
      },
    );
  }

  const TILE_ICON: Record<Tile, IconComponent> = {
    overdue: CircleAlert,
    today: AlarmClock,
    week: CalendarDays,
    committed: CalendarCheck,
  };

  function href(mut: (p: URLSearchParams) => void): string {
    const u = new URL(page.url);
    mut(u.searchParams);
    return `${u.pathname}${u.search}`;
  }
  const nav = (to: string) => goto(to, { keepFocus: true, noScroll: true, replaceState: true });

  function stageOf(t: MyTicket, b: Board | undefined) {
    return b?.stages.find((s) => s.id === t.stageId) ?? null;
  }

  function fmtDue(t: MyTicket): string {
    if (t.dueAt == null) return '—';
    const opts: Intl.DateTimeFormatOptions = t.dueAllDay
      ? { month: 'short', day: 'numeric', timeZone: tz }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz };
    try {
      return new Intl.DateTimeFormat(undefined, opts).format(new Date(t.dueAt));
    } catch {
      return new Date(t.dueAt).toLocaleDateString();
    }
  }
  function dueTone(t: MyTicket): string {
    if (t.dueAt == null) return 'text-subtle';
    if (overdue(t, $now, tz)) return 'text-danger font-medium';
    const d = dayRange($now, tz);
    if (t.dueAt >= d.start && t.dueAt < d.end) return 'text-warning font-medium';
    return 'text-muted';
  }

  function setCommitment(t: MyTicket, value: number | null) {
    if (!uid) return;
    outbox.queue(
      'ticketUpdate',
      { boardId: t.boardId, ticketId: t.id, patch: { commitments: { [uid]: value } } },
      {
        kind: 'ticket',
        label: `set your commitment on ${t.key}`,
        openTo: href((p) => p.set('ticket', t.key)),
        optimistic: {
          path: paths.ticket(t.boardId, t.id),
          patch: { [`commitments.${uid}`]: value },
        },
      },
    );
  }

  const EMPTY = {
    assigned: 'Nothing is assigned to you right now.',
    created: 'No open tickets you created.',
    watching: 'You aren’t watching any open tickets.',
  } as const;
</script>

<svelte:head><title>My work · TaskManager</title></svelte:head>

<SearchProviders />
<PushPrompt />

<div class="px-4 py-4 md:px-6 {ticketKey ? 'lg:pr-[min(42rem,55vw)]' : ''}">
  <h1 class="text-lg font-semibold">My work</h1>

  <div class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
    {#each TILES as t (t.id)}
      {@const Icon = TILE_ICON[t.id]}
      {@const active = tile === t.id}
      <button
        type="button"
        aria-pressed={active}
        onclick={() => nav(href((p) => (active ? p.delete('tile') : p.set('tile', t.id))))}
        class="flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors
          {active ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'}"
      >
        <span class="flex items-center gap-1.5 text-xs text-muted">
          <Icon
            size={14}
            aria-hidden="true"
            class={t.id === 'overdue' && counts.overdue ? 'text-danger' : ''}
          />
          {t.label}
        </span>
        <span
          class="text-2xl font-semibold tabular-nums {t.id === 'overdue' && counts.overdue
            ? 'text-danger'
            : ''}"
        >
          {$q.loading ? '–' : counts[t.id]}
        </span>
      </button>
    {/each}
  </div>

  <Tabs
    class="mt-4 -mx-1"
    label="Whose tickets"
    value={scope}
    items={SCOPES.map((s) => ({
      id: s.id,
      label: s.label,
      href: href((p) => (s.id === 'assigned' ? p.delete('scope') : p.set('scope', s.id))),
    }))}
  />

  <div class="mt-3 overflow-x-auto rounded-lg border border-line bg-surface">
    {#if $q.loading}
      <!-- Rows shaped like the table's. -->
      <div
        class="flex flex-col divide-y divide-line"
        aria-busy="true"
        aria-label="Loading your tickets"
      >
        {#each [0, 1, 2, 3, 4] as i (i)}
          <div class="flex items-center gap-4 px-3 py-2.5">
            <Skeleton width="4rem" height="0.75rem" />
            <Skeleton width="{35 + (i % 3) * 12}%" />
            <span class="ml-auto hidden gap-4 sm:flex"
              ><Skeleton width="6rem" height="0.75rem" /><Skeleton
                width="5rem"
                height="0.75rem"
              /></span
            >
          </div>
        {/each}
      </div>
    {:else if $q.error}
      <EmptyState
        icon={CircleAlert}
        title="Couldn't load your tickets"
        description={$q.error.message}
        class="py-12"
      />
    {:else if !rows.length}
      <EmptyState
        icon={SquareCheck}
        title={tile
          ? `Nothing ${TILES.find((t) => t.id === tile)?.label.toLowerCase()}`
          : 'All clear'}
        description={EMPTY[scope]}
        class="py-12"
      >
        {#snippet action()}
          {#if tile}<Button size="sm" onclick={() => nav(href((p) => p.delete('tile')))}
              >Show all</Button
            >{/if}
        {/snippet}
      </EmptyState>
    {:else}
      <table class="w-full min-w-[44rem] text-sm">
        <thead class="border-b border-line text-left text-xs text-muted">
          <tr>
            <th class="w-24 px-3 py-2 font-medium">Key</th>
            <th class="px-3 py-2 font-medium">Title</th>
            <th class="w-36 px-3 py-2 font-medium">Board</th>
            <th class="w-32 px-3 py-2 font-medium">Stage</th>
            <th class="w-32 px-3 py-2 font-medium">Due</th>
            <th class="w-40 px-3 py-2 font-medium">Commitment</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as t (t.boardId + '/' + t.id)}
            {@const b = boards.get(t.boardId)}
            {@const st = stageOf(t, b)}
            <tr
              class="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2 {ticketKey ===
              t.key
                ? 'bg-accent-soft'
                : ''}"
              onclick={() => nav(href((p) => p.set('ticket', t.key)))}
            >
              <td class="px-3 py-2 font-mono text-xs text-muted">
                <a
                  href={href((p) => p.set('ticket', t.key))}
                  onclick={(e) => e.preventDefault()}
                  class="hover:underline">{t.key}</a
                >
              </td>
              <td class="max-w-0 px-3 py-2">
                {#if b}
                  <TicketSummary
                    ticket={t}
                    board={{ ...b, id: t.boardId }}
                    me={uid ?? ''}
                    {tz}
                    now={$now}
                    fields={null}
                    layout="row"
                    showKey={false}
                    unread={isUnread(t, readAt.get(t.id), uid ?? '')}
                    since={counted.has(t.id) ? (readAt.get(t.id) ?? 0) : null}
                    unsent={outbox.hasUnsent(t.id)}
                    blocked={isBlocked(t, byId)}
                    tasks={tasklistSignalOfTicket(t)}
                    waiting={questionSignalOfTicket(t, uid ?? '', $now)}
                    assignees={{
                      editable: canAssign(t, b),
                      choices: $choicesQ.get(t.boardId) ?? [],
                      onchange: (uids) => setAssignees(t, uids),
                    }}
                  />
                {:else}
                  <span class="truncate">{t.title}</span>
                {/if}
              </td>
              <td class="truncate px-3 py-2 text-muted">
                {#if b}
                  <a
                    href={routes.board(b.key)}
                    onclick={(e) => e.stopPropagation()}
                    class="inline-flex items-center gap-1.5 hover:underline"
                    ><Indicator of={b} seed={b.id} size="xs" />{b.name}</a
                  >
                {:else}—{/if}
              </td>
              <td class="px-3 py-2">
                {#if st}
                  <span class="inline-flex items-center gap-1.5">
                    <Indicator of={st} seed={st.id} size="sm" />
                    <span class="truncate">{st.name}</span>
                  </span>
                {:else}<span class="text-subtle">—</span>{/if}
              </td>
              <td class="px-3 py-2 whitespace-nowrap {dueTone(t)}">{fmtDue(t)}</td>
              <td class="px-3 py-1" onclick={(e) => e.stopPropagation()}>
                <DatePicker
                  value={uid ? (t.commitments?.[uid] ?? null) : null}
                  allDay={true}
                  withTime={false}
                  {tz}
                  placeholder="Commit…"
                  label="My commitment for {t.key}"
                  onchange={(v) => void setCommitment(t, v)}
                />
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>

{#if ticketKey}
  {#key ticketKey}
    <TicketDrawer {ticketKey} onClose={() => nav(href((p) => p.delete('ticket')))} />
  {/key}
{/if}

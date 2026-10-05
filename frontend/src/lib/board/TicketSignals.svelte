<!--
  §P2 › the top row's 'look at me' signals, as one component so the kanban
  card, the table's title cell and My work all say the same thing:

    💬 3   ⚠   ❓ Waiting for you   $402   ●

  · 💬  the unread count from my read pointer (./summary › unreadBadge); muted
        total once everything is read, and nothing at all with no thread
  · ⚠   a message of mine has not gone out yet (the outbox)
  · ❓  a blocking question — accent when it is waiting for MY answer
  · $   aggregates.html: one chip per aggregate field shown on cards (Cost —
        what the agents' turns have cost — and any other), once non-zero
  · ●   the agent health dot, with what it is doing in its tooltip

  Everything is optional and nothing empty is drawn, so a quiet ticket renders
  an empty fragment.
-->
<script lang="ts">
  import { MessageSquare, TriangleAlert } from 'lucide-svelte';
  import Badge from '$lib/ui/Badge.svelte';
  import type { AggChip } from '$lib/aggregates/fields';
  import { waitingBadgeLabel } from '$lib/ticket/question';
  import TicketAgentHealth from '$lib/agents/TicketAgentHealth.svelte';
  import type { QuestionSignal } from './signals';
  import type { UnreadBadge } from './summary';

  interface Props {
    badge?: UnreadBadge | null;
    unsent?: boolean;
    waiting?: QuestionSignal | null;
    /** aggregates.html: the ticket's totals to draw (cardChips: showOnCard, non-zero). */
    aggs?: readonly AggChip[];
    /** The health dot is drawn only when both are known. */
    boardId?: string | null;
    ticketId?: string | null;
  }
  // A caller that draws the signals in two places (the table's Chat and
  // Activity columns) simply leaves out the props the other place owns.
  let {
    badge = null,
    unsent = false,
    waiting = null,
    aggs = [],
    boardId = null,
    ticketId = null,
  }: Props = $props();
</script>

{#if badge}
  <span
    class="inline-flex shrink-0 items-center gap-0.5 text-[11px] {badge.unread
      ? 'rounded-full bg-accent-soft px-1.5 font-semibold text-accent'
      : 'text-subtle'}"
    aria-label={badge.label}
    title={badge.label}
    data-unread={badge.unread ? badge.text : undefined}
  >
    <MessageSquare size={11} aria-hidden="true" />{badge.text}
  </span>
{/if}
{#if unsent}
  <span
    class="inline-flex shrink-0 text-warning"
    title="A message you wrote has not been sent yet"
    aria-label="Unsent message"
  >
    <TriangleAlert size={12} />
  </span>
{/if}
{#if waiting?.waiting}
  <span data-waiting title={waiting.title ?? undefined} class="min-w-0 overflow-hidden">
    <Badge tone="accent"
      ><span aria-hidden="true">❓</span>{waitingBadgeLabel(waiting.waiting)}</Badge
    >
  </span>
{:else if waiting?.open}
  <span data-waiting title={waiting.title ?? undefined} class="min-w-0 overflow-hidden">
    <Badge><span aria-hidden="true">❓</span>Waiting for an answer</Badge>
  </span>
{/if}
{#each aggs as a (a.id)}
  <span
    data-agg={a.id}
    data-cost={a.id === 'cost' ? '' : undefined}
    class="inline-flex shrink-0 items-center rounded-full bg-surface-2 px-1.5 text-[11px] font-medium text-muted tabular-nums"
    title={a.title}
    aria-label={a.title}
  >
    {a.text}
  </span>
{/each}
{#if boardId && ticketId}
  <!-- Phase 3 (§L3): a green dot while an agent is working on this ticket. -->
  <TicketAgentHealth {boardId} {ticketId} dotOnly />
{/if}

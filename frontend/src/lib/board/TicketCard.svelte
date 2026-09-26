<!--
  THE BOARD CARD (agents.html §P2) — the kanban's wrapper around
  ./TicketSummary, which is also what the table's title cell and My work draw,
  "so all three agree". Everything here is the BOARD's half: what this board
  knows about the ticket (its signals, my read pointer, whether I may reassign
  it), handed to a component that takes plain props.

    ENG-42 ⧉        💬 3  ⚠  ❓ Waiting for you  ●      ← is anything new?
    Fix the login redirect after SSO, which wraps          ← what is it?
    onto a second line and stops there
    [High] [bug] [Sep 24] [3 pts] [☑ 4/7] [📎 2] [⛔]  (avatars +)  ← late? whose?

  `compact` is the calendar's one-line chip, which has room for none of that.
-->
<script lang="ts">
  import { TriangleAlert } from 'lucide-svelte';
  import { outbox } from '$lib/api';
  import TicketAgentHealth from '$lib/agents/TicketAgentHealth.svelte';
  import { questionSignalOfTicket, tasklistSignalOfTicket } from './signals';
  import { isBlocked } from './summary';
  import TicketSummary from './TicketSummary.svelte';
  import { useBoard, type BoardDoc, type BoardTicket } from './context.svelte';
  import { updateTicket } from './ops';

  interface Props {
    /** The loaded board (§Q4) — never null: cards are only drawn under one. */
    board: BoardDoc;
    ticket: BoardTicket;
    cardFields: string[];
    /** Compact one-line chip (calendar). */
    compact?: boolean;
    /** 'row' is the table's title cell: one line, no key of its own (§P2 reuse). */
    layout?: 'card' | 'row';
    showKey?: boolean;
    showTitle?: boolean;
  }
  let {
    board,
    ticket: t,
    cardFields,
    compact = false,
    layout = 'card',
    showKey = true,
    showTitle = true,
  }: Props = $props();
  const bs = useBoard();

  const blocked = $derived(isBlocked(t, bs.byId));

  // ——— the '4/7' task-list chip (§L2) and the ❓ Waiting badge (§L1), both
  // read STRAIGHT off the ticket document the board list already has (§W).
  // Phase 3's two collection-group listeners are gone: a card never queries.
  const tasks = $derived(tasklistSignalOfTicket(t));
  const asked = $derived(questionSignalOfTicket(t, bs.me, bs.now));
  const unsent = $derived(outbox.hasUnsent(t.id));

  /** §P2: assignees are editable unless I may not — a viewer gets no picker and no '+'. */
  const mayAssign = $derived(bs.can('assign', t));

  function setAssignees(uids: string[]) {
    void updateTicket(bs, t, { assigneeUids: uids }, { failure: `change who has ${t.key}` });
  }
</script>

{#if compact}
  <span class="flex min-w-0 items-center gap-1 text-xs">
    {#if t.priorityId}
      {@const p = board.priorities.find((x) => x.id === t.priorityId)}
      {#if p?.color}<span class="size-1.5 shrink-0 rounded-full" style="background:{p.color}"
        ></span>{/if}
    {/if}
    <span class="shrink-0 font-mono text-[10px] text-subtle">{t.key}</span>
    <span class="truncate {t.stageCategory === 'done' ? 'text-muted line-through' : ''}"
      >{t.title}</span
    >
    <TicketAgentHealth boardId={board.id} ticketId={t.id} dotOnly size={7} />
    {#if asked?.waiting}<span
        class="shrink-0"
        title="Waiting for your answer"
        aria-label="Waiting for your answer">❓</span
      >{/if}
    {#if unsent}<TriangleAlert
        size={11}
        class="shrink-0 text-warning"
        aria-label="Unsent message"
      />{/if}
    {#if blocked}<span class="shrink-0 text-danger" title="Blocked" aria-label="Blocked">⛔</span
      >{/if}
  </span>
{:else}
  <TicketSummary
    ticket={t}
    {board}
    me={bs.me}
    tz={bs.tz}
    now={bs.now}
    fields={cardFields}
    {layout}
    {showKey}
    {showTitle}
    unread={bs.unread(t)}
    since={bs.unreadSince(t)}
    {unsent}
    {blocked}
    {tasks}
    waiting={asked}
    assignees={cardFields.includes('assignee')
      ? { editable: mayAssign, choices: bs.peopleChoices, onchange: setAssignees }
      : null}
  />
{/if}

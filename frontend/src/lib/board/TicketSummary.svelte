<!--
  ONE TICKET, SUMMARISED (agents.html §P2). This is the card — and, in `row`
  layout, the table's title cell and a My work row, because §P2 asks that "the
  same card is used by the table's title cell and by My work, so all three
  agree".

  It takes everything it needs as props (no board context), so the three call
  sites differ only in what they hand it:

    kanban      fields = the view's cardFields, assignees editable in place
    table cell  fields = the facts that have no column of their own
    My work     fields = null → whatever this ticket actually has

  What it decides for itself is the unread count: given my read pointer it
  counts the ticket's own inline messages (./signals › unreadOfTicket, §W2) —
  the same pointer the thread's 'New messages' divider uses, so opening the
  ticket clears the badge here too. No listener, no query: `since: null` just
  means 'do not count this one'.

  EMPTY FACTS ARE NEVER DRAWN, and a card with nothing to say stays two lines:
  with no facts the assignees sit beside the key instead of opening a third
  row.
-->
<script lang="ts">
  import { Copy } from 'lucide-svelte';
  import type { Board, TicketWithId } from '@tm/shared';
  import { toast } from '$lib/ui/toast.svelte';
  import type { ChoiceItem } from '$lib/views/pickers/ChoicePicker.svelte';
  import CardAssignees from './CardAssignees.svelte';
  import TicketFacts from './TicketFacts.svelte';
  import TicketSignals from './TicketSignals.svelte';
  import { unreadOfTicket, type QuestionSignal, type TasklistSignal } from './signals';
  import { cardFacts, unreadBadge } from './summary';

  interface Props {
    ticket: TicketWithId;
    board: Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields'> & { id: string };
    me: string;
    tz: string;
    now: number;
    /** The view's cardFields; null = every fact this ticket actually has. */
    fields: readonly string[] | null;
    /** Is there something in the thread I have not read? */
    unread?: boolean;
    /** My read pointer to count from — null = do not count (opens nothing). */
    since?: number | null;
    /** A message of mine on this ticket has not gone out yet. */
    unsent?: boolean;
    /** ⛔ — blocked by a ticket that is not done. */
    blocked?: boolean;
    tasks?: TasklistSignal | null;
    waiting?: QuestionSignal | null;
    /** Assignees, editable in place. null = do not draw them at all. */
    assignees?: {
      editable: boolean;
      choices: ChoiceItem[];
      onchange: (uids: string[]) => void;
    } | null;
    /** 'card' stacks (kanban); 'row' is one line (table cell, My work). */
    layout?: 'card' | 'row';
    /** The key, click-to-copy — off in a table that already has a Key column. */
    showKey?: boolean;
    /** The title — off where the row draws its own. */
    showTitle?: boolean;
    /**
     * 'row' only. The table gives the thread and what is going on their own
     * columns instead of packing them in front of the title, where a narrow
     * column drew the badges over the text:
     *   'title'     the title alone
     *   'chat'      the unread count and the unsent mark
     *   'activity'  the ❓ question, the facts (task list, files, blocked), cost, agent dot
     * 'all' (default) is the one-line summary My work draws.
     */
    part?: 'all' | 'title' | 'chat' | 'activity';
  }
  let {
    ticket: t,
    board,
    me,
    tz,
    now,
    fields,
    unread = false,
    since = null,
    unsent = false,
    blocked = false,
    tasks = null,
    waiting = null,
    assignees = null,
    layout = 'card',
    showKey = true,
    showTitle = true,
    part = 'all',
  }: Props = $props();

  // §W2: the count comes out of the ticket's OWN inline thread — no listener,
  // no query, nothing to wait for. null = this ticket cannot be counted (it is
  // read, past the board's cap, or written before §W folded the thread in).
  const counted = $derived(unreadOfTicket(t, since, me));
  const badge = $derived(
    unreadBadge(t.counts.messages, unread, counted?.count ?? null, counted?.capped ?? false),
  );

  const facts = $derived(cardFacts(t, { board, tz, now, fields, blocked, tasks }));
  /** A viewer with nobody assigned has nothing to draw — an empty fact. */
  const showAssignees = $derived(!!assignees && (assignees.editable || t.assigneeUids.length > 0));

  async function copyKey(e: MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(t.key);
      toast.success(`Copied ${t.key}`);
    } catch {
      toast.error('Could not copy');
    }
  }
</script>

{#snippet assigneeCluster()}
  {#if assignees && showAssignees}
    <CardAssignees
      uids={t.assigneeUids}
      editable={assignees.editable}
      choices={assignees.choices}
      onchange={assignees.onchange}
      label="Assignees on {t.key}"
    />
  {/if}
{/snippet}

{#if layout === 'row'}
  <!-- One line: signals, the title, then whatever facts are left over. -->
  <span class="flex min-w-0 items-center gap-1.5 overflow-hidden" data-summary="row">
    {#if part === 'chat'}
      <TicketSignals {badge} {unsent} />
    {:else if part === 'activity'}
      <TicketSignals {waiting} cost={t.cost ?? null} boardId={board.id} ticketId={t.id} />
      <TicketFacts {facts} inline />
    {:else}
      {#if part === 'all'}
        <TicketSignals
          {badge}
          {unsent}
          {waiting}
          cost={t.cost ?? null}
          boardId={board.id}
          ticketId={t.id}
        />
      {/if}
      {#if showTitle}
        <span
          class="truncate {t.state !== 'active' ? 'text-muted line-through' : ''}"
          title={t.title}>{t.title}</span
        >
      {/if}
      {#if part === 'all'}
        <TicketFacts {facts} inline />
        {@render assigneeCluster()}
      {/if}
    {/if}
  </span>
{:else}
  <div class="flex min-w-0 flex-col gap-1" data-summary="card">
    <!-- Top: the key, then everything that means 'look at me'. -->
    <div class="flex min-w-0 items-center gap-1.5">
      {#if showKey}
        <button
          type="button"
          class="group/key shrink-0 font-mono text-[11px] text-subtle hover:text-text"
          title="Copy {t.key}"
          aria-label="Copy {t.key}"
          onclick={copyKey}
        >
          {t.key}<Copy
            size={10}
            class="ml-0.5 inline opacity-0 group-hover/key:opacity-100"
            aria-hidden="true"
          />
        </button>
      {/if}
      <span class="ml-auto flex min-w-0 items-center gap-1.5">
        <TicketSignals
          {badge}
          {unsent}
          {waiting}
          cost={t.cost ?? null}
          boardId={board.id}
          ticketId={t.id}
        />
        <!-- No meta row for them to sit at the end of: stay two lines (§P2). -->
        {#if !facts.length}{@render assigneeCluster()}{/if}
      </span>
    </div>

    {#if showTitle}
      <!-- Title: up to two lines, then it stops. -->
      <p
        class="line-clamp-2 text-sm leading-snug break-words {t.state !== 'active'
          ? 'text-muted line-through'
          : ''}"
        title={t.title}
      >
        {t.title}
      </p>
    {/if}

    {#if facts.length}
      <div class="flex min-w-0 items-end gap-1.5">
        <TicketFacts {facts} class="flex-1" />
        <span class="ml-auto shrink-0">{@render assigneeCluster()}</span>
      </div>
    {/if}
  </div>
{/if}

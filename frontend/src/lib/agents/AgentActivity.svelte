<!--
  What one agent is doing right now (agents.html §L3 › 'The Agents page shows
  each agent's agent-level status and its tickets currently being worked on').

    <AgentActivity agentId={a.id} boardIds={[…]} />
      🟢 Working · Planning the export
      ENG-42  🟢 Working · Running tests (3/12)
      ENG-51  🔴 No signal for 3 min

  One agentStatus listener per board — the same ones the board pages use.
-->
<script lang="ts">
  import { agentStatusAcross } from './agentStatus';
  import { agentLead, healthClock, liveTickets } from './health';
  import AgentHealth from './AgentHealth.svelte';
  import AgentTicketRow from './AgentTicketRow.svelte';

  interface Props {
    agentId: string;
    /** The boards this agent is on — where its beats can be. */
    boardIds: string[];
    tz?: string;
    /** Leave the ticket list out (the compact row on the Agents list). */
    ticketsShown?: boolean;
    class?: string;
  }
  let { agentId, boardIds, tz, ticketsShown = true, class: cls = '' }: Props = $props();

  const rows = $derived(agentStatusAcross(boardIds));
  const lead = $derived(agentLead($rows, agentId, $healthClock));
  const live = $derived(ticketsShown ? liveTickets($rows, agentId, $healthClock) : []);
</script>

<div class="flex min-w-0 flex-col gap-1 {cls}" data-agent-activity={agentId}>
  <AgentHealth status={lead} {tz} />
  {#if live.length}
    <ul class="flex flex-col gap-0.5">
      {#each live as s (s.id)}
        <li><AgentTicketRow boardId={s.boardId} ticketId={s.ticketId!} status={s} {tz} /></li>
      {/each}
    </ul>
  {/if}
</div>

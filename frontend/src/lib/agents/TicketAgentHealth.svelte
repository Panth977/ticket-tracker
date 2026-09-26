<!--
  What an agent is doing ON THIS TICKET (agents.html §L3) — the drawer header's
  line and the board card's dot. Both read the board's ONE agentStatus
  listener; when several agents are on the ticket the loudest one speaks
  (error → no signal → working → idle → finished).

    <TicketAgentHealth {boardId} {ticketId} {tz} />
    <TicketAgentHealth {boardId} {ticketId} dotOnly />
-->
<script lang="ts">
  import { person } from '$lib/people';
  import { boardAgentStatus } from './agentStatus';
  import { healthClock, leadStatus } from './health';
  import AgentHealth from './AgentHealth.svelte';

  interface Props {
    boardId: string | null | undefined;
    ticketId: string | null | undefined;
    /** Just the dot (cards). */
    dotOnly?: boolean;
    /** Put the agent's name in front of the state (the drawer header). */
    withName?: boolean;
    tz?: string;
    size?: number;
    class?: string;
  }
  let {
    boardId,
    ticketId,
    dotOnly = false,
    withName = false,
    tz,
    size = 8,
    class: cls = '',
  }: Props = $props();

  const statuses = $derived(boardAgentStatus(boardId));
  const status = $derived(ticketId ? leadStatus($statuses.data, ticketId, $healthClock) : null);
  const who = $derived(person(withName ? (status?.agentId ?? null) : null));
  const name = $derived(withName && status ? ($who.person?.name ?? 'Agent') : undefined);
</script>

<AgentHealth {status} {dotOnly} {name} {tz} {size} class={cls} />

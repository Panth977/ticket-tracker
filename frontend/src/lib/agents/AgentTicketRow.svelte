<!--
  One ticket an agent is on, as the Agents page lists it: the key (a link to
  the ticket) and what the agent is doing there. The key comes from the ticket
  document; while it loads, the row shows nothing but the state, so the page
  never waits.
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- lib/layout/routes; the SPA has no base path */
  import { paths, type AgentStatus, type Ticket } from '@tm/shared';
  import { routes } from '$lib/layout/routes';
  import { docStore, type WithId } from '$lib/stores';
  import AgentHealth from './AgentHealth.svelte';

  interface Props {
    boardId: string;
    ticketId: string;
    status: WithId<AgentStatus> | AgentStatus;
    tz?: string;
  }
  let { boardId, ticketId, status, tz }: Props = $props();

  const tk = $derived(docStore<Ticket>(paths.ticket(boardId, ticketId)));
  const ticket = $derived($tk.data);
</script>

<span class="flex min-w-0 items-center gap-2 text-xs">
  {#if ticket}
    <a href={routes.ticket(ticket.key)} class="shrink-0 font-mono text-subtle hover:text-accent"
      >{ticket.key}</a
    >
    <span class="min-w-0 truncate text-muted">{ticket.title}</span>
  {/if}
  <AgentHealth {status} {tz} class="ml-auto shrink-0" />
</span>

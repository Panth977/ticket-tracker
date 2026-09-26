<!--
  You › Agents (agents.html §B): the agent profiles I own — name, picture,
  description, the boards each is on — and New agent. An agent is what an
  orchestrator acts as: added to boards like a person, assigned and mentioned
  like a person, reached only through a token.
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- agentRoutes; the SPA has no base path */
  import { Archive, Bot, Plus } from 'lucide-svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { boardsOfAgent, myAgents, sortAgents } from '$lib/agents/agents';
  import AgentActivity from '$lib/agents/AgentActivity.svelte';
  import NewAgentDialog from '$lib/agents/NewAgentDialog.svelte';
  import { agentRoutes } from '$lib/agents/routes';
  import { AgentBadge, PrincipalAvatar } from '$lib/people';
  import { myBoards } from '$lib/stores';
  import { Badge, Button, EmptyState, Skeleton } from '$lib/ui';

  const agentsQ = $derived(myAgents(auth.uid));
  const boardsQ = $derived(myBoards(auth.uid));
  let showArchived = $state(false);
  const all = $derived(sortAgents($agentsQ.data));
  const active = $derived(all.filter((a) => a.archivedAt == null));
  const archived = $derived(all.filter((a) => a.archivedAt != null));
  let creating = $state(false);
</script>

<svelte:head><title>Agents · TaskManager</title></svelte:head>

<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-8">
  <header class="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
    <div>
      <h1 class="flex items-center gap-2 text-xl font-semibold"><Bot size={20} /> Agents</h1>
      <p class="mt-1 max-w-prose text-sm text-muted">
        Profiles your orchestrators act as. Add an agent to a board like a person, assign it
        tickets, @-mention it, and give your orchestrator a token that acts as it.
      </p>
    </div>
    <Button variant="primary" icon={Plus} onclick={() => (creating = true)}>New agent</Button>
  </header>

  {#if $agentsQ.loading}
    <Skeleton lines={3} height="4rem" />
  {:else if $agentsQ.error}
    <p class="text-sm text-danger" role="alert">Couldn’t load your agents.</p>
  {:else if !active.length && !archived.length}
    <EmptyState
      icon={Bot}
      title="No agents yet"
      description="Create one — e.g. “Builder”, with a system prompt your orchestrator loads from its token."
    >
      {#snippet action()}<Button icon={Plus} onclick={() => (creating = true)}>New agent</Button
        >{/snippet}
    </EmptyState>
  {:else}
    <ul class="grid grid-cols-1 gap-3 sm:grid-cols-2" data-agent-list>
      {#each active as a (a.id)}
        {@const boards = boardsOfAgent($boardsQ.data, a.id)}
        <li>
          <a
            href={agentRoutes.agent(a.id)}
            class="flex h-full items-start gap-3 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-accent/50 hover:bg-surface-2"
          >
            <PrincipalAvatar id={a.id} size={40} />
            <span class="flex min-w-0 flex-1 flex-col gap-1">
              <span class="flex items-center gap-1.5">
                <span class="truncate font-medium">{a.name}</span>
                <AgentBadge />
              </span>
              {#if a.description}<span class="line-clamp-2 text-sm text-muted">{a.description}</span
                >{/if}
              <!-- Phase 3 (§L3): the agent-level dot, from each board's one agentStatus listener. -->
              <AgentActivity
                agentId={a.id}
                boardIds={boards.map((r) => r.board.id)}
                ticketsShown={false}
              />
              <span class="flex flex-wrap gap-1 pt-1">
                {#each boards as r (r.board.id)}
                  <Badge>{r.board.key} · {r.role}</Badge>
                {:else}
                  <span class="text-xs text-subtle">Not on a board</span>
                {/each}
              </span>
            </span>
          </a>
        </li>
      {/each}
    </ul>

    {#if archived.length}
      <section class="flex flex-col gap-2">
        <button
          type="button"
          class="flex items-center gap-1.5 self-start text-sm text-muted hover:text-text"
          onclick={() => (showArchived = !showArchived)}
          aria-expanded={showArchived}
        >
          <Archive size={14} /> Archived ({archived.length})
        </button>
        {#if showArchived}
          <ul class="divide-y divide-line rounded-xl border border-line bg-surface">
            {#each archived as a (a.id)}
              <li>
                <a
                  href={agentRoutes.agent(a.id)}
                  class="flex items-center gap-3 px-4 py-2 text-sm opacity-70 hover:bg-surface-2 hover:opacity-100"
                >
                  <PrincipalAvatar id={a.id} size={24} />
                  <span class="font-medium">{a.name}</span>
                  <span class="text-muted">archived</span>
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<NewAgentDialog bind:open={creating} />

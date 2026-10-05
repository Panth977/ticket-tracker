<!--
  People & roles › Add agent (agents.html §C): a board admin adds one of THEIR
  agents directly — no invite — as viewer, commenter (with an optional stage
  grant), editor or ADMIN (§AA2: the old "never admin" rule is gone; what no
  agent can do, even as admin, is manage people, invite or mint tokens).
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- agentRoutes; the SPA has no base path */
  import { Bot, Plus } from 'lucide-svelte';
  import type { AgentBoardRole, Board, StageGrant } from '@tm/shared';
  import {
    addAgentToBoard,
    AGENT_NEVER,
    AGENT_ROLE_HINT,
    AGENT_ROLE_LABEL,
    AGENT_ROLE_ORDER,
  } from '$lib/agents/actions';
  import { myAgents, sortAgents } from '$lib/agents/agents';
  import { agentRoutes } from '$lib/agents/routes';
  import StageGrantEditor from '$lib/board/StageGrantEditor.svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { PrincipalAvatar } from '$lib/people';
  import type { WithId } from '$lib/stores';
  import { Button, toast } from '$lib/ui';

  let { board }: { board: WithId<Board> } = $props();

  const agentsQ = $derived(myAgents(auth.uid));
  const available = $derived(
    sortAgents($agentsQ.data).filter((a) => a.archivedAt == null && board.access[a.id] == null),
  );
  const hasAny = $derived($agentsQ.data.some((a) => a.archivedAt == null));

  let agentId = $state('');
  let role = $state<AgentBoardRole>('editor');
  let grant = $state<StageGrant | null>(null);
  let busy = $state(false);
  $effect(() => {
    if (!available.some((a) => a.id === agentId)) agentId = available[0]?.id ?? '';
  });
  const picked = $derived(available.find((a) => a.id === agentId) ?? null);

  async function add(e: SubmitEvent) {
    e.preventDefault();
    if (!picked) return;
    busy = true;
    if (await addAgentToBoard(board.id, picked.id, role, grant)) {
      toast.success(`${picked.name} added as ${AGENT_ROLE_LABEL[role].toLowerCase()}`);
      grant = null;
    }
    busy = false;
  }
</script>

<form
  class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5"
  onsubmit={add}
  aria-label="Add agent"
  data-add-agent
>
  <div>
    <h3 class="flex items-center gap-1.5 font-medium"><Bot size={15} /> Add agent</h3>
    <p class="text-sm text-muted">
      Your agents join at once — no invite. Assign them tickets and @-mention them like anyone else.
    </p>
  </div>
  {#if $agentsQ.loading}
    <p class="text-sm text-muted">Loading your agents…</p>
  {:else if !available.length}
    <p class="text-sm text-muted">
      {#if hasAny}All your agents are already on this board.{:else}You have no agents yet.{/if}
      <a href={agentRoutes.list()} class="text-accent hover:underline"
        >{hasAny ? 'Manage agents' : 'Create an agent'}</a
      >
    </p>
  {:else}
    <div class="flex flex-wrap items-end gap-2">
      <label class="flex min-w-56 flex-1 flex-col gap-1 text-sm">
        <span class="text-xs text-muted">Agent</span>
        <span class="flex items-center gap-2">
          {#if picked}<PrincipalAvatar id={picked.id} size={28} />{/if}
          <select
            bind:value={agentId}
            class="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm"
            aria-label="Agent"
          >
            {#each available as a (a.id)}<option value={a.id}
                >{a.name}{a.description ? ` — ${a.description}` : ''}</option
              >{/each}
          </select>
        </span>
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-xs text-muted">Role</span>
        <select
          bind:value={role}
          class="h-9 rounded-md border border-line bg-surface px-2 text-sm"
          aria-label="Role"
          title={AGENT_ROLE_HINT[role]}
        >
          {#each AGENT_ROLE_ORDER as r (r)}<option value={r}>{AGENT_ROLE_LABEL[r]}</option>{/each}
        </select>
      </label>
      <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={!picked}
        >Add agent</Button
      >
    </div>
    {#if role === 'commenter'}
      <StageGrantEditor
        stages={board.stages}
        {grant}
        onchange={(g) => (grant = g)}
        label="Stages it may move tickets between"
      />
    {/if}
    <p class="text-xs text-muted">
      {AGENT_ROLE_LABEL[role]}: {AGENT_ROLE_HINT[role]}.
      {#if role === 'admin'}{AGENT_NEVER}.{/if}
    </p>
  {/if}
</form>

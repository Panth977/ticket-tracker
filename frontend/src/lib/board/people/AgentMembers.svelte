<!--
  People & roles › the board's agents (agents.html §C, §AA2): picture, name,
  Agent badge and owner; role (viewer / commenter / editor / ADMIN — §AA2: an
  agent may be admin now, and on a board the role is the permission) and stage
  grant, changed by any admin through boardAgentSet; ⋯ Remove (unassigns it;
  its token stops reaching this board — its messages stay).
-->
<script lang="ts">
  import { Bot, ExternalLink, MoreHorizontal, UserMinus } from 'lucide-svelte';
  import type { AgentBoardRole, Board, BoardMember } from '@tm/shared';
  import { agentRoleOf } from '$lib/agents/access';
  import {
    AGENT_ROLE_HINT,
    AGENT_ROLE_LABEL,
    AGENT_ROLE_ORDER,
    removeAgentFromBoard,
    setAgentGrant,
    setAgentRole,
  } from '$lib/agents/actions';
  import AgentHealth from '$lib/agents/AgentHealth.svelte';
  import { boardAgentStatus } from '$lib/agents/agentStatus';
  import { agentLead, healthClock } from '$lib/agents/health';
  import { agentRoutes } from '$lib/agents/routes';
  import StageGrantEditor from '$lib/board/StageGrantEditor.svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { Principal } from '$lib/people';
  import type { WithId } from '$lib/stores';
  import Menu from '$lib/ui/Menu.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import type { MenuItem } from '$lib/ui/types';

  interface Props {
    board: WithId<Board>;
    agents: WithId<BoardMember>[];
    isAdmin: boolean;
  }
  let { board, agents, isAdmin }: Props = $props();
  const archived = $derived(board.archivedAt != null);
  const canEdit = $derived(isAdmin && !archived);
  let busy = $state<string | null>(null);

  // Phase 3 (§L3): the same dot as everywhere else — one listener for the board.
  const statuses = $derived(boardAgentStatus(board.id));
  const healthOf = (agentId: string) => agentLead($statuses.data, agentId, $healthClock);

  const roleOf = (m: BoardMember) => agentRoleOf(m.role);
  const grantOf = (m: BoardMember) => board.stageGrants[m.uid] ?? m.stageGrant;

  async function role(m: BoardMember, r: AgentBoardRole) {
    if (r === m.role) return;
    busy = m.uid;
    if (await setAgentRole(board.id, m.uid, r, grantOf(m) != null))
      toast.success(`${m.name} is now ${AGENT_ROLE_LABEL[r].toLowerCase()}`);
    busy = null;
  }
  async function remove(m: BoardMember) {
    if (
      !confirm(
        `Remove ${m.name} (agent) from ${board.name}? It is unassigned from its tickets here and its token stops reaching this board at once. Its messages stay.`,
      )
    )
      return;
    busy = m.uid;
    if (await removeAgentFromBoard(board.id, m.uid)) toast.success(`Removed ${m.name}`);
    busy = null;
  }
  function menu(m: BoardMember): MenuItem[] {
    const items: MenuItem[] = [];
    if (m.ownerUid === auth.uid)
      items.push({ label: 'Open agent', icon: ExternalLink, href: agentRoutes.agent(m.uid) });
    if (canEdit)
      items.push({
        label: 'Remove from board',
        icon: UserMinus,
        danger: true,
        disabled: busy === m.uid,
        onSelect: () => remove(m),
      });
    return items;
  }
</script>

<section class="flex flex-col gap-2" aria-label="Agents on this board" data-board-agents>
  <h3 class="flex items-center gap-1.5 font-medium">
    <Bot size={15} /> Agents <span class="text-sm font-normal text-muted">{agents.length}</span>
  </h3>
  {#if !agents.length}
    <p class="text-sm text-muted">No agents on this board.</p>
  {:else}
    <div class="overflow-x-auto rounded-xl border border-line bg-surface">
      <table class="w-full min-w-[40rem] text-sm">
        <thead class="border-b border-line text-left text-xs text-muted">
          <tr>
            <th class="px-4 py-2 font-medium">Agent</th>
            <th class="px-2 py-2 font-medium">Role on this board</th>
            <th class="px-2 py-2 font-medium">Stage grant</th>
            <th class="w-10 px-2 py-2"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-line">
          {#each agents as m (m.uid)}
            {@const items = menu(m)}
            <tr data-agent-row={m.uid}>
              <td class="px-4 py-2">
                <Principal id={m.uid} layout="stacked" />
                <AgentHealth status={healthOf(m.uid)} class="mt-0.5" />
              </td>
              <td class="px-2 py-2">
                {#if canEdit}
                  <select
                    class="h-8 rounded-md border border-line bg-surface px-1.5"
                    value={m.role}
                    aria-label="Role of {m.name}"
                    disabled={busy === m.uid}
                    title={AGENT_ROLE_HINT[roleOf(m)]}
                    onchange={(e) => {
                      const r = e.currentTarget.value as AgentBoardRole;
                      e.currentTarget.value = m.role; // the live member doc decides what shows
                      void role(m, r);
                    }}
                  >
                    {#each AGENT_ROLE_ORDER as r (r)}<option value={r}>{AGENT_ROLE_LABEL[r]}</option
                      >{/each}
                  </select>
                {:else}
                  <span title={AGENT_ROLE_HINT[roleOf(m)]}
                    >{AGENT_ROLE_LABEL[roleOf(m)] ?? m.role}</span
                  >
                {/if}
              </td>
              <td class="px-2 py-2">
                {#if m.role === 'commenter'}
                  {#if canEdit}
                    <StageGrantEditor
                      stages={board.stages}
                      grant={grantOf(m)}
                      onchange={(g) => setAgentGrant(board.id, m.uid, 'commenter', g)}
                    />
                  {:else}
                    {@const g = grantOf(m)}
                    <span class="text-xs text-muted">
                      {g?.stages.length
                        ? g.stages
                            .map((id) => board.stages.find((s) => s.id === id)?.name ?? '?')
                            .join(', ')
                        : 'None'}
                      {#if g?.assignedOnly}
                        · only its tickets{/if}
                    </span>
                  {/if}
                {:else}
                  <span class="text-xs text-subtle">—</span>
                {/if}
              </td>
              <td class="px-2 py-2">
                {#if items.length}
                  <Menu placement="bottom-end" {items}>
                    {#snippet trigger(p)}
                      <button
                        type="button"
                        {...p}
                        class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2"
                        aria-label="More for {m.name}"
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    {/snippet}
                  </Menu>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

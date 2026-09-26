<!--
  Boards this agent is on (agents.html §B/§C) — role, a link to the board's
  People page, remove — and "Add to a board" for boards where I am admin.
  Board access maps hold agents too, so this reads only my boards.
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- hrefs from lib/layout/routes / agentRoutes; no base path */
  import { KeyRound, LayoutGrid, Plus, UserMinus } from 'lucide-svelte';
  import { AGENT_BOARD_ROLES, type AgentBoardRole, type StageGrant } from '@tm/shared';
  import StageGrantEditor from '$lib/board/StageGrantEditor.svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { myBoards } from '$lib/stores';
  import { Button, EmptyState, Skeleton, toast } from '$lib/ui';
  import {
    addAgentToBoard,
    AGENT_ROLE_HINT,
    AGENT_ROLE_LABEL,
    removeAgentFromBoard,
    setAgentRole,
  } from './actions';
  import { boardsOfAgent, boardsToAddAgent } from './agents';
  import { agentRoutes } from './routes';

  interface Props {
    agentId: string;
    name: string;
    archived: boolean;
  }
  let { agentId, name, archived }: Props = $props();

  const me = $derived(auth.uid ?? '');
  const boardsQ = $derived(myBoards(me));
  const rows = $derived(boardsOfAgent($boardsQ.data, agentId));
  const addable = $derived(boardsToAddAgent($boardsQ.data, me, agentId));

  let addBoard = $state<string>('');
  let addRole = $state<AgentBoardRole>('editor');
  let addGrant = $state<StageGrant | null>(null);
  let adding = $state(false);
  let busy = $state<string | null>(null);
  $effect(() => {
    if (!addable.some((b) => b.id === addBoard)) addBoard = addable[0]?.id ?? '';
  });
  const addTarget = $derived(addable.find((b) => b.id === addBoard) ?? null);

  async function add(e: SubmitEvent) {
    e.preventDefault();
    if (!addTarget) return;
    adding = true;
    if (await addAgentToBoard(addTarget.id, agentId, addRole, addGrant)) {
      toast.success(`${name} added to ${addTarget.name}`);
      addGrant = null;
    }
    adding = false;
  }

  async function role(boardId: string, r: AgentBoardRole, had: boolean) {
    busy = boardId;
    await setAgentRole(boardId, agentId, r, had);
    busy = null;
  }
  async function remove(boardId: string, boardName: string) {
    if (
      !confirm(
        `Take ${name} off ${boardName}? It is unassigned from its tickets there and its tokens for that board stop working. Its messages stay.`,
      )
    )
      return;
    busy = boardId;
    if (await removeAgentFromBoard(boardId, agentId))
      toast.success(`${name} removed from ${boardName}`);
    busy = null;
  }
</script>

{#if $boardsQ.loading}
  <Skeleton lines={2} height="2.5rem" />
{:else}
  {#if rows.length}
    <ul class="divide-y divide-line rounded-lg border border-line" data-agent-boards>
      {#each rows as r (r.board.id)}
        {@const admin = r.board.access[me] === 'admin'}
        <li class="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
          <a
            href={routes.boardPeople(r.board.key)}
            class="flex min-w-0 flex-1 items-center gap-2 hover:underline"
          >
            <span class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted"
              >{r.board.key}</span
            >
            <span class="truncate font-medium">{r.board.name}</span>
          </a>
          {#if admin && !archived}
            <select
              class="h-8 rounded-md border border-line bg-surface px-1.5"
              aria-label="Role of {name} on {r.board.name}"
              value={r.role}
              disabled={busy === r.board.id}
              title={AGENT_ROLE_HINT[r.role as AgentBoardRole]}
              onchange={(e) => {
                const v = e.currentTarget.value as AgentBoardRole;
                e.currentTarget.value = r.role;
                void role(r.board.id, v, r.board.stageGrants?.[agentId] != null);
              }}
            >
              {#each AGENT_BOARD_ROLES as x (x)}<option value={x}>{AGENT_ROLE_LABEL[x]}</option
                >{/each}
            </select>
          {:else}
            <span class="text-muted">{AGENT_ROLE_LABEL[r.role as AgentBoardRole] ?? r.role}</span>
          {/if}
          <Button
            size="sm"
            variant="ghost"
            icon={KeyRound}
            href={agentRoutes.newToken({ boardId: r.board.id, agentId })}
            disabled={archived}
          >
            Token
          </Button>
          {#if admin}
            <Button
              size="sm"
              variant="ghost"
              class="text-danger"
              icon={UserMinus}
              disabled={busy === r.board.id}
              onclick={() => remove(r.board.id, r.board.name)}
            >
              Remove
            </Button>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <EmptyState
      icon={LayoutGrid}
      title="Not on any board yet"
      description="Add it to a board so it can be assigned tickets and get a token."
    />
  {/if}

  {#if !archived}
    {#if addable.length}
      <form
        class="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3"
        onsubmit={add}
        aria-label="Add {name} to a board"
      >
        <div class="flex flex-wrap items-end gap-2">
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-xs text-muted">Board</span>
            <select
              bind:value={addBoard}
              class="h-9 min-w-44 rounded-md border border-line bg-surface px-2 text-sm"
            >
              {#each addable as b (b.id)}<option value={b.id}>{b.key} · {b.name}</option>{/each}
            </select>
          </label>
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-xs text-muted">Role</span>
            <select
              bind:value={addRole}
              class="h-9 rounded-md border border-line bg-surface px-2 text-sm"
              title={AGENT_ROLE_HINT[addRole]}
            >
              {#each AGENT_BOARD_ROLES as x (x)}<option value={x}>{AGENT_ROLE_LABEL[x]}</option
                >{/each}
            </select>
          </label>
          <Button type="submit" variant="primary" icon={Plus} loading={adding} disabled={!addTarget}
            >Add to board</Button
          >
        </div>
        {#if addRole === 'commenter' && addTarget}
          <StageGrantEditor
            stages={addTarget.stages}
            grant={addGrant}
            onchange={(g) => (addGrant = g)}
          />
        {/if}
        <p class="text-xs text-muted">
          {AGENT_ROLE_LABEL[addRole]}: {AGENT_ROLE_HINT[addRole]}. Agents are never admins.
        </p>
      </form>
    {:else if !rows.length || $boardsQ.data.length}
      <p class="text-xs text-muted">You can add it to boards where you are an admin.</p>
    {/if}
  {/if}
{/if}

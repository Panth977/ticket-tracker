<!--
  The agent's page › ACCESS › Boards (agents.html §AA2, §AA5): every board the
  agent is on, with its role — and on a board THE ROLE IS THE PERMISSION, so
  this select is the whole answer to "what may it do there?". Viewer /
  Commenter / Editor / Admin (an agent may be admin now), each with its line
  from §AA2's table; a commenter's stage grant (the same editor the board's
  People section uses); Remove; and "Add to a board" for boards where I am
  admin and it is not on yet.

  boardAgentSet needs a board admin, so on a board where I am not one the
  controls are there but disabled, with a tooltip saying why.

  WHERE THE LIST COMES FROM: my boards (where readerUids has me) — their access
  maps hold agents too. The rules do not let a person ask "boards where
  agentIds has this agent"; see ./access.
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- hrefs from lib/layout/routes / agentRoutes; no base path */
  import { LayoutGrid, Plus, UserMinus } from 'lucide-svelte';
  import type { AgentBoardRole, StageGrant } from '@tm/shared';
  import StageGrantEditor from '$lib/board/StageGrantEditor.svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { myBoards } from '$lib/stores';
  import { Button, EmptyState, Skeleton, toast } from '$lib/ui';
  import {
    AGENT_NEVER,
    AGENT_ROLE_HINT,
    AGENT_ROLE_LABEL,
    AGENT_ROLE_ORDER,
    agentRoleOf,
  } from './access';
  import { addAgentToBoard, removeAgentFromBoard, setAgentGrant, setAgentRole } from './actions';
  import { boardsOfAgent, boardsToAddAgent } from './agents';

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

  async function role(boardId: string, boardName: string, r: AgentBoardRole, had: boolean) {
    busy = boardId;
    if (await setAgentRole(boardId, agentId, r, had))
      toast.success(`${name} is now ${AGENT_ROLE_LABEL[r].toLowerCase()} on ${boardName}`);
    busy = null;
  }
  async function grant(boardId: string, g: StageGrant | null) {
    busy = boardId;
    await setAgentGrant(boardId, agentId, 'commenter', g);
    busy = null;
  }
  async function remove(boardId: string, boardName: string) {
    if (
      !confirm(
        `Take ${name} off ${boardName}? It is unassigned from its tickets there and its token stops reaching that board at once. Its messages stay.`,
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
        {@const can = admin && !archived}
        {@const current = agentRoleOf(r.role)}
        {@const why = archived
          ? 'Restore the agent to change this'
          : `Only an admin of ${r.board.name} can change this`}
        <li class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
          <a
            href={routes.boardPeople(r.board.key)}
            class="flex min-w-0 flex-1 basis-40 items-center gap-2 hover:underline"
            title="Open {r.board.name} › People"
          >
            <span class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted"
              >{r.board.key}</span
            >
            <span class="truncate font-medium">{r.board.name}</span>
          </a>
          <!-- The title sits on a wrapper: a disabled <select> shows no tooltip of its own. -->
          <span title={can ? AGENT_ROLE_HINT[current] : why}>
            <select
              class="h-8 rounded-md border border-line bg-surface px-1.5 disabled:text-muted"
              aria-label="Role of {name} on {r.board.name}"
              value={current}
              disabled={!can || busy === r.board.id}
              onchange={(e) => {
                const v = e.currentTarget.value as AgentBoardRole;
                e.currentTarget.value = current; // the live board decides what shows
                if (v !== current)
                  void role(r.board.id, r.board.name, v, r.board.stageGrants?.[agentId] != null);
              }}
            >
              {#each AGENT_ROLE_ORDER as x (x)}<option value={x}>{AGENT_ROLE_LABEL[x]}</option
                >{/each}
            </select>
          </span>
          <span title={admin ? undefined : why}>
            <Button
              size="sm"
              variant="ghost"
              class="text-danger"
              icon={UserMinus}
              disabled={!admin || busy === r.board.id}
              onclick={() => remove(r.board.id, r.board.name)}
            >
              Remove
            </Button>
          </span>
          <p class="w-full text-xs text-muted">{AGENT_ROLE_HINT[current]}.</p>
          {#if current === 'commenter'}
            <!-- §AA2: a commenter moves tickets only inside its stage grant. -->
            <div class="w-full" title={can ? undefined : why}>
              <StageGrantEditor
                stages={r.board.stages}
                grant={r.board.stageGrants?.[agentId] ?? null}
                disabled={!can || busy === r.board.id}
                label="Stages it may move tickets between"
                onchange={(g) => void grant(r.board.id, g)}
              />
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <EmptyState
      icon={LayoutGrid}
      title="Not on any board yet"
      description="Add it to a board so it can be assigned tickets, mentioned, and reach the board with its token."
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
          <label class="flex min-w-0 flex-1 basis-44 flex-col gap-1 text-sm">
            <span class="text-xs text-muted">Add to a board</span>
            <select
              bind:value={addBoard}
              class="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm"
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
              {#each AGENT_ROLE_ORDER as x (x)}<option value={x}>{AGENT_ROLE_LABEL[x]}</option
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
            label="Stages it may move tickets between"
            onchange={(g) => (addGrant = g)}
          />
        {/if}
        <p class="text-xs text-muted">
          {AGENT_ROLE_LABEL[addRole]}: {AGENT_ROLE_HINT[addRole]}.
          {#if addRole === 'admin'}{AGENT_NEVER}.{/if}
        </p>
      </form>
    {:else}
      <p class="text-xs text-muted">
        {#if $boardsQ.data.some((b) => b.archivedAt == null && b.access?.[me] === 'admin')}
          It is already on every board you administer.
        {:else}
          You can add it to boards where you are an admin.
        {/if}
      </p>
    {/if}
  {/if}
{/if}

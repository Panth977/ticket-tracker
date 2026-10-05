<!--
  /agents/{agentId} (agents.html §B): name, picture (upload + crop) or icon,
  description, system prompt (Markdown editor with preview), and — §AA5 — the
  two cards where its access is read and set:
    TOKEN   the agent's ONE token (generate / regenerate, shown once; older
            converted tokens listed until they are revoked)
    SUBSCRIPTIONS  every board it is on with its role, every artifact with
            Build and data (lib/access) — "what may this agent do?" has one answer, and it is here
  then archive / restore. Owner only: anyone else gets "not found" (agents are
  private).
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- agentRoutes; the SPA has no base path */
  import { page } from '$app/state';
  import { beforeNavigate } from '$app/navigation';
  import { Archive, ArchiveRestore, ArrowLeft, Bot, Copy, Save } from 'lucide-svelte';
  import { paths, type Agent } from '@tm/shared';
  import { command } from '$lib/api';
  import Panel from '$lib/account/Panel.svelte';
  import AgentAvatarEditor from '$lib/agents/AgentAvatarEditor.svelte';
  import AgentActivity from '$lib/agents/AgentActivity.svelte';
  import AgentSubscriptions from '$lib/agents/AgentSubscriptions.svelte';
  import AgentTokenCard from '$lib/agents/AgentTokenCard.svelte';
  import PromptEditor from '$lib/agents/PromptEditor.svelte';
  import {
    AGENT_DESCRIPTION_MAX,
    AGENT_NAME_MAX,
    draftErrors,
    draftOf,
    draftPatch,
    type AgentDraft,
  } from '$lib/agents/agents';
  import { boardsOfAgent } from '$lib/agents/agents';
  import { agentRoutes } from '$lib/agents/routes';
  import { myBoards } from '$lib/stores';
  import { auth } from '$lib/firebase/auth.svelte';
  import { AgentBadge } from '$lib/people';
  import { docStore } from '$lib/stores';
  import { Badge, Button, Dialog, EmptyState, Input, Skeleton, toast } from '$lib/ui';

  const agentId = $derived(page.params.agentId ?? '');
  const agentQ = $derived(docStore<Agent>(paths.agent(agentId)));
  const agent = $derived($agentQ.data && $agentQ.data.ownerUid === auth.uid ? $agentQ.data : null);
  const archived = $derived(agent?.archivedAt != null);
  // Phase 3 (§L3): where its heartbeats can be — the boards it is on.
  const boardsQ = $derived(myBoards(auth.uid));
  const statusBoards = $derived(boardsOfAgent($boardsQ.data, agentId).map((r) => r.board.id));
  const tz = $derived(auth.profile?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);

  // The draft follows the saved agent until the owner starts typing.
  let draft = $state<AgentDraft>({ name: '', description: '', systemPrompt: '' });
  let loadedFor = $state<string | null>(null);
  let savedAt = $state(0);
  $effect(() => {
    const a = agent;
    if (!a) return;
    const stamp = `${agentId}:${a.updatedAt}`;
    if (loadedFor === stamp) return;
    // Take server changes when clean (or on first load); keep local edits otherwise.
    if (loadedFor === null || !loadedFor.startsWith(agentId + ':') || !dirty) draft = draftOf(a);
    loadedFor = stamp;
  });
  const patch = $derived(agent ? draftPatch(agent, draft) : {});
  const dirty = $derived(Object.keys(patch).length > 0);
  const errors = $derived(draftErrors(draft));
  const valid = $derived(Object.keys(errors).length === 0);
  let saving = $state(false);

  async function save() {
    if (!agent || !dirty || !valid || saving || archived) return;
    saving = true;
    try {
      await command(
        'agentUpdate',
        { agentId, ...patch },
        {
          optimistic: { path: paths.agent(agentId), patch: { ...patch } },
          toast: 'Could not save the agent',
        },
      );
      savedAt = Date.now();
      toast.success('Saved');
    } catch {
      /* toasted */
    } finally {
      saving = false;
    }
  }

  beforeNavigate((nav) => {
    if (dirty && !saving && !confirm('Leave without saving your changes to this agent?'))
      nav.cancel();
  });

  // ── archive / restore ──
  let archiveOpen = $state(false);
  let archiving = $state(false);
  async function archive(action: 'archive' | 'restore') {
    archiving = true;
    try {
      const r = await command(
        'agentArchive',
        { agentId, action },
        { toast: action === 'archive' ? 'Could not archive' : 'Could not restore' },
      );
      archiveOpen = false;
      toast.success(
        action === 'archive'
          ? `${agent?.name ?? 'Agent'} archived`
          : `${agent?.name ?? 'Agent'} restored`,
        action === 'archive'
          ? `Left ${r.boardsLeft} board${r.boardsLeft === 1 ? '' : 's'}; ${r.tokensRevoked} token${r.tokensRevoked === 1 ? '' : 's'} revoked.`
          : 'Add it to boards and generate a token to use it again.',
      );
    } catch {
      /* toasted */
    } finally {
      archiving = false;
    }
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(agentId);
      toast.success('Agent id copied');
    } catch {
      toast.error('Could not copy');
    }
  }
</script>

<svelte:head><title>{agent?.name ?? 'Agent'} · Agents · TaskManager</title></svelte:head>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-8">
  <a
    href={agentRoutes.list()}
    class="flex items-center gap-1 self-start text-sm text-muted hover:text-text"
    ><ArrowLeft size={14} /> Agents</a
  >

  {#if $agentQ.loading}
    <Skeleton lines={6} height="3rem" />
  {:else if !agent}
    <EmptyState
      icon={Bot}
      title="Agent not found"
      description="It doesn’t exist, or it belongs to someone else — agents are private to their owner."
    >
      {#snippet action()}<Button href={agentRoutes.list()}>Your agents</Button>{/snippet}
    </EmptyState>
  {:else}
    <header class="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
      <div class="flex min-w-0 items-center gap-2">
        <h1 class="truncate text-xl font-semibold">{agent.name}</h1>
        <AgentBadge />
        {#if archived}<Badge tone="warning">Archived</Badge>{/if}
        <button
          type="button"
          class="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs text-subtle hover:bg-surface-2"
          title="Copy the agent id"
          onclick={copyId}
        >
          {agentId}
          <Copy size={11} />
        </button>
      </div>
      <div class="flex items-center gap-2">
        {#if dirty}<span class="text-xs text-muted">Unsaved changes</span>{:else if savedAt}<span
            class="text-xs text-subtle">All changes saved</span
          >{/if}
        {#if !archived}
          <Button
            variant="primary"
            icon={Save}
            loading={saving}
            disabled={!dirty || !valid}
            onclick={save}>Save</Button
          >
        {/if}
      </div>
    </header>

    {#if archived}
      <p class="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
        This agent is archived: it is off every board and its token was revoked. Restore it to edit
        it or use it again.
      </p>
    {/if}

    <Panel
      title="Profile"
      description="Shown wherever the agent appears: on tickets, in pickers and in threads."
    >
      <AgentAvatarEditor
        {agentId}
        name={agent.name}
        avatarPath={agent.avatarPath}
        icon={agent.icon ?? null}
        disabled={archived}
      />
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label="Name"
          maxlength={AGENT_NAME_MAX}
          bind:value={draft.name}
          error={errors.name}
          disabled={archived}
          required
        />
        <Input
          label="Description"
          hint="One line, shown in pickers."
          maxlength={AGENT_DESCRIPTION_MAX}
          bind:value={draft.description}
          error={errors.description}
          disabled={archived}
        />
      </div>
    </Panel>

    <Panel
      title="System prompt"
      description="What this agent is and how it works. Your orchestrator reads it through the agent’s token."
    >
      {#if archived}
        <pre
          class="max-h-96 overflow-auto rounded-md border border-line bg-surface-2 p-3 font-mono text-xs whitespace-pre-wrap">{agent.systemPrompt}</pre>
      {:else}
        <PromptEditor bind:value={draft.systemPrompt} error={errors.systemPrompt} onsave={save} />
      {/if}
    </Panel>

    <Panel
      title="Now"
      description="What your orchestrator last said it was doing — a heartbeat a minute while it works (§L3)."
    >
      <AgentActivity {agentId} boardIds={statusBoards} {tz} class="text-sm" />
      {#if !statusBoards.length}<p class="text-sm text-muted">
          Add it to a board and its heartbeats show up here.
        </p>{/if}
    </Panel>

    <!-- §AA5 — the two cards. The token says WHO; Access says WHAT. -->
    <Panel
      title="Token"
      description="One token for this agent. It says who the agent is and nothing else — what it may do is set in Subscriptions, below."
    >
      <AgentTokenCard {agentId} name={agent.name} {archived} />
    </Panel>

    <Panel
      title="Subscriptions"
      description="Everything this agent may use: a role on each board (the role is the permission) and Build / data on each artifact. A change here applies to its token at once."
    >
      <AgentSubscriptions {agentId} name={agent.name} {archived} />
    </Panel>

    <Panel title={archived ? 'Restore' : 'Archive'} tone={archived ? 'default' : 'danger'}>
      {#if archived}
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-sm text-muted">
            Restoring doesn’t put it back on boards or bring back its token.
          </p>
          <Button icon={ArchiveRestore} loading={archiving} onclick={() => archive('restore')}
            >Restore agent</Button
          >
        </div>
      {:else}
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-sm text-muted">
            Takes it off every board and revokes its token. Its messages stay.
          </p>
          <Button variant="danger" icon={Archive} onclick={() => (archiveOpen = true)}
            >Archive agent</Button
          >
        </div>
      {/if}
    </Panel>
  {/if}
</div>

<Dialog bind:open={archiveOpen} title="Archive {agent?.name ?? 'this agent'}?" size="sm">
  <ul class="list-disc pl-5 text-sm">
    <li>It is removed from every board, and unassigned from its tickets there.</li>
    <li>Its token stops working at once.</li>
    <li>Its messages and files stay.</li>
  </ul>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (archiveOpen = false)}>Cancel</Button>
    <Button variant="danger" loading={archiving} onclick={() => archive('archive')}
      >Archive agent</Button
    >
  {/snippet}
</Dialog>

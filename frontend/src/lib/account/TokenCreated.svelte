<!--
  The ONE time a token is visible (agents.html §E, §R1): the token, a
  ready-to-paste MCP config, curl examples and env vars — each with a copy
  button. Stored as a hash, so it can't be shown again.

  §R1: an ACCOUNT token gets the Claude-ready snippets first, because that is
  what it is for — `claude mcp add … --scope user` puts TaskManager in every
  project, and the first thing to tell a model is to call list_boards.

  §AA1/§AA5: an AGENT token (kind 'agent', made on the agent's page) names no
  board — it reaches every board and artifact the agent is on — and gets the
  one line most callers want first: TM_TOKEN=…, what the SDK and workspaces read.
-->
<script lang="ts">
  import { TriangleAlert } from 'lucide-svelte';
  import { curlExamples, mcpClientConfig } from '@tm/shared';
  import { Tabs } from '$lib/ui';
  import CopyBlock from './CopyBlock.svelte';

  interface Props {
    token: string;
    apiBase: string;
    name: string;
    /** 'Builder (agent)' or 'you' */
    actsAs: string;
    /** Board tokens only. */
    boardName?: string;
    /** §R1: 'board' or 'account'; §AA1: 'agent'. */
    kind?: 'board' | 'account' | 'agent';
    /** Account tokens: how many boards it reaches today. */
    boardCount?: number;
  }
  let {
    token,
    apiBase,
    name,
    actsAs,
    boardName = '',
    kind = 'board',
    boardCount = 0,
  }: Props = $props();
  const account = $derived(kind === 'account');
  const agent = $derived(kind === 'agent');

  const serverName = $derived(
    `taskmanager-${
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'token'
    }`,
  );
  const mcp = $derived(
    JSON.stringify(mcpClientConfig({ key: token, apiBase, serverName }), null, 2),
  );
  const curls = $derived(curlExamples({ key: token, apiBase }));
  const claudeCli = $derived(
    `claude mcp add --transport http ${serverName} ${apiBase}/mcp --header "Authorization: Bearer ${token}"`,
  );
  /** §R1/§R3: the same command with --scope user, so it is there in every project. */
  const claudeCliUser = $derived(`${claudeCli} --scope user`);
  const envVars = $derived(
    `export TASKMANAGER_API=${apiBase}/v1\nexport TASKMANAGER_MCP=${apiBase}/mcp\nexport TASKMANAGER_TOKEN=${token}`,
  );
  let tab = $state('mcp');
</script>

<div class="flex flex-col gap-4" data-token-created>
  <p class="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
    <TriangleAlert size={16} class="mt-0.5 shrink-0" aria-hidden="true" />
    This is the only time you’ll see it. We store a hash, so it can’t be shown again.
  </p>
  <CopyBlock label="Token" text={token} wrap />
  <p class="-mt-2 text-xs text-muted">
    {#if account}
      Acts as <strong>you</strong> on
      <strong>every board you are on</strong>{boardCount ? ` (${boardCount} today)` : ''}, as that
      stands at each call.
    {:else if agent}
      Acts as <strong>{actsAs}</strong> on
      <strong>every board and artifact it is on</strong>, as that stands at each call. What it may
      do there is its role on the board and its permission on the artifact.
    {:else}
      Acts as <strong>{actsAs}</strong> on <strong>{boardName}</strong>.
    {/if}
    Send it as <code>Authorization: Bearer …</code> to
    <code>{apiBase}/v1</code> (REST) or <code>{apiBase}/mcp</code> (MCP).
  </p>
  {#if agent}
    <!-- §AA5: the short "how to use it" line — the SDK's createClient({ token: process.env.TM_TOKEN }). -->
    <CopyBlock label="How to use it — set it where the agent runs" text="TM_TOKEN={token}" wrap />
  {/if}
  <Tabs
    label="How to use it"
    items={[
      { id: 'mcp', label: 'MCP config' },
      { id: 'curl', label: 'curl' },
      { id: 'env', label: 'Env vars' },
    ]}
    bind:value={tab}
  />
  {#if tab === 'mcp'}
    {#if account}
      <!-- §R3: one command, and the --scope user variant for every project. -->
      <CopyBlock label="Claude Code — this project" text={claudeCli} wrap />
      <CopyBlock label="Claude Code — every project" text={claudeCliUser} wrap />
      <CopyBlock label="Or paste into mcp.json (Claude Desktop, Cursor …)" text={mcp} />
      <p class="text-xs text-muted">
        Check it with <code>/mcp</code> in Claude Code. Tell the model to call
        <code>list_boards</code>
        first: every tool that works on a board takes a <code>board</code> key, unless the call
        already names a ticket like
        <code>ENG-42</code>.
      </p>
    {:else}
      <CopyBlock label="mcp.json (Claude Code / Desktop, Cursor …)" text={mcp} />
      <CopyBlock label="Or with the Claude Code CLI" text={claudeCli} wrap />
      <p class="text-xs text-muted">
        {#if agent}
          Every tool that works on a board takes a <code>board</code> key unless the agent is on exactly
          one board.
        {:else}
          Tools this token’s permissions don’t allow are hidden.
        {/if}
        <code>whoami</code> returns who the token acts as{agent
          ? ', with the agent’s system prompt'
          : ''}.
      </p>
    {/if}
  {:else if tab === 'curl'}
    {#each curls as c, i (i)}
      <CopyBlock text={c} wrap />
    {/each}
    <p class="text-xs text-muted">
      Full reference: <code>{apiBase}/v1/openapi.json</code>. Every POST takes an
      <code>Idempotency-Key</code>.
    </p>
  {:else}
    <CopyBlock label="Shell" text={envVars} />
  {/if}
</div>

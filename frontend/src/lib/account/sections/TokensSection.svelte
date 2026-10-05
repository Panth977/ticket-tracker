<!--
  Account › Tokens (agents.html §E, §R1): every token I made — name, what it
  reaches, permissions, last used, expiry, revoke — and New token.

  BOARD TOKENS are grouped by board and act as me.
  AGENT TOKENS (§AA1, §AA5) are listed READ-ONLY, in their own group: an agent
  has one token, generated, replaced and revoked on the agent's own page —
  each row links there. That group also holds any legacy board token still
  acting as an agent (§AA6), because it is managed in the same place.
  ACCOUNT TOKENS (§R1) have no board: they act as me on every board I am on,
  as that stands at each call, so they get their own group at the top and are
  marked plainly. Either way the string (tm_live_…) is shown once, with ready
  snippets. Stored as a hash; revoking takes effect on the next request.

  ?new=1&board={boardId} opens the form prefilled; ?new=1&kind=account the
  account form. An old ?new=1&agent={agentId} link goes to that agent's page,
  where its token is made now (§AA5).
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- agentRoutes; the SPA has no base path */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { env } from '$env/dynamic/public';
  import { Bot, Globe, KeyRound, Plus } from 'lucide-svelte';
  import { apiKeyKind, paths, SCOPE_PRESETS, type ApiKey } from '@tm/shared';
  import { command } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { Principal } from '$lib/people';
  import { myBoards, queryStore, type WithId } from '$lib/stores';
  import { Badge, Button, Dialog, EmptyState, Skeleton, toast } from '$lib/ui';
  import { dateOnly, relativeTime } from '../format';
  import CopyBlock from '../CopyBlock.svelte';
  import SectionHeader from '../SectionHeader.svelte';
  import TokenCreated from '../TokenCreated.svelte';
  import TokenForm from '../TokenForm.svelte';
  import {
    ACCOUNT_DEFAULT_EXPIRY,
    apiBase,
    keyState,
    revokedReasonLabel,
    scopesSummary,
    scopesTooltip,
    sortKeys,
    tokenDraftErrors,
    tokenKindLabel,
    tokenRequest,
    type TokenDraft,
  } from '../tokens';
  import { isAgentKey } from '$lib/agents/access';
  import { agentRoutes } from '$lib/agents/routes';

  const keysQ = $derived(queryStore<ApiKey>(auth.uid ? { path: paths.apiKeys(auth.uid) } : null));
  const boardsQ = $derived(myBoards(auth.uid));
  const activeBoards = $derived(
    $boardsQ.data.filter((b) => b.archivedAt == null).sort((a, b) => a.name.localeCompare(b.name)),
  );
  const tz = $derived(auth.profile?.timezone);
  const base = $derived(
    apiBase(env.PUBLIC_API_BASE, typeof location === 'undefined' ? '' : location.origin),
  );
  /**
   * The integration context (§O) is served by HOSTING, beside the app — not by
   * the API, which may live on another origin in development. So it hangs off
   * the window's origin rather than `base`.
   */
  const origin = $derived(typeof location === 'undefined' ? '' : location.origin);

  let boardFilter = $state<string>('all');
  let showInactive = $state(false);
  const keys = $derived(sortKeys($keysQ.data));
  /*
   * §R1: an account token belongs to no board, so the board filter must not
   * hide it — filtering to 'ENG' asks "what can reach ENG?", and an account
   * token can.
   */
  const shown = $derived(
    keys.filter(
      (k) =>
        (boardFilter === 'all' ||
          apiKeyKind(k) === 'account' ||
          apiKeyKind(k) === 'agent' ||
          k.boardId === boardFilter ||
          (k.defaultBoardId ?? null) === boardFilter) &&
        (showInactive || keyState(k) === 'active'),
    ),
  );
  const accountKeys = $derived(shown.filter((k) => apiKeyKind(k) === 'account'));
  /*
   * §AA5: every key acting as an agent — the kind 'agent' token (no board, so
   * the board filter never hides it, as for an account token) and a legacy
   * board token acting as an agent (which the filter treats like any board
   * token). Read-only here.
   */
  const agentKeys = $derived(shown.filter((k) => isAgentKey(k)));
  const inactiveCount = $derived(keys.filter((k) => keyState(k) !== 'active').length);
  const boardName = (id: string) =>
    $boardsQ.data.find((b) => b.id === id)?.name ?? 'A board you left';
  const boardKey = (id: string) => $boardsQ.data.find((b) => b.id === id)?.key ?? '—';
  /** Rows grouped by board, boards by name. */
  const groups = $derived.by(() => {
    const by: Record<string, WithId<ApiKey>[]> = {};
    // Account tokens are listed on their own, above (they have no board).
    // Agent tokens too (§AA5), legacy board ones included.
    for (const k of shown) if (k.boardId && !isAgentKey(k)) (by[k.boardId] ??= []).push(k);
    return Object.entries(by)
      .map(([boardId, list]) => ({ boardId, list }))
      .sort((a, b) => boardName(a.boardId).localeCompare(boardName(b.boardId)));
  });

  // ── create ──
  const blank = (): TokenDraft => ({
    name: '',
    kind: 'board',
    boardId: activeBoards.length === 1 ? activeBoards[0]!.id : null,
    scopes: [...SCOPE_PRESETS.worker],
    expiry: '90',
  });
  let createOpen = $state(false);
  let draft = $state<TokenDraft>(blank());
  let touched = $state(false);
  let creating = $state(false);
  /** The one time the key is visible. */
  let created = $state<{
    key: string;
    name: string;
    boardName: string;
    kind: 'board' | 'account';
    boardCount: number;
  } | null>(null);

  function openCreate(pre: Partial<TokenDraft> = {}) {
    draft = { ...blank(), ...pre };
    touched = false;
    created = null;
    createOpen = true;
  }

  onMount(() => {
    const q = page.url.searchParams;
    if (q.get('new') !== '1') return;
    // §AA5: an agent's token is made on the agent's page. An old link lands there.
    const agentId = q.get('agent');
    if (agentId) {
      void goto(agentRoutes.agent(agentId), { replaceState: true });
      return;
    }
    // ?new=1&kind=account — what the Claude setup guide (§R3) links to.
    if (q.get('kind') === 'account') {
      openCreate({
        kind: 'account',
        boardId: null,
        scopes: [...SCOPE_PRESETS.fullAccount],
        expiry: ACCOUNT_DEFAULT_EXPIRY,
      });
      return;
    }
    openCreate({ ...(q.get('board') ? { boardId: q.get('board') } : {}) });
  });
  async function create(e: SubmitEvent) {
    e.preventDefault();
    touched = true;
    if (Object.keys(tokenDraftErrors(draft)).length) return;
    creating = true;
    try {
      const req = tokenRequest(draft);
      const r = await command('apiKeyCreate', req, { toast: 'Could not create the token' });
      created = {
        key: r.key,
        name: req.name,
        boardName: req.boardId ? boardName(req.boardId) : '',
        kind: req.kind,
        boardCount: activeBoards.length,
      };
    } catch {
      /* toasted */
    } finally {
      creating = false;
    }
  }

  // ── revoke ──
  let target = $state<WithId<ApiKey> | null>(null);
  let revokeOpen = $state(false);
  let revoking = $state(false);
  async function revoke() {
    if (!target || !auth.uid) return;
    revoking = true;
    const k = target;
    try {
      await command(
        'apiKeyRevoke',
        { keyId: k.id },
        {
          optimistic: {
            path: paths.apiKey(auth.uid, k.id),
            patch: { revokedAt: Date.now(), revokedReason: 'owner' },
          },
          toast: 'Could not revoke',
        },
      );
      toast.success(`${k.name} revoked`);
      revokeOpen = false;
    } catch {
      /* toasted */
    } finally {
      revoking = false;
    }
  }
</script>

<SectionHeader
  title="Tokens"
  description="Keys for orchestrators, agents and scripts to use the REST API and MCP. A board token works on one board, as you; an account token acts as you on every board you are on — either only narrows what your role already allows. Each of your agents has one token of its own, made on the agent’s page and listed here."
>
  {#snippet actions()}<Button variant="primary" icon={Plus} onclick={() => openCreate()}
      >New token</Button
    >{/snippet}
</SectionHeader>

<!--
  agents.html §O — the one URL an orchestrator is pointed at. A token is useless
  to an agent that does not know what to do with it, and this is the page that
  tells it: generated from the API itself, so it can never be out of date.
-->
<div class="mb-4 rounded-xl border border-line bg-surface p-3">
  <p class="mb-2 text-sm text-muted">
    <span class="font-medium text-text">For your agent.</span> One URL that teaches an orchestrator
    this whole API — what the software is, how this token works, REST, MCP and the SDK, with a
    runnable example.
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- a static file beside the app, not an SPA route -->
    <a class="text-accent underline" href="{origin}/integrate" target="_blank" rel="noreferrer"
      >Read it as a page</a
    >.
    <!-- §R3 — the same token inside Claude Code, as a plugin: guide + downloadable bundle. -->
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- a static file beside the app, not an SPA route -->
    <a
      class="text-accent underline"
      href="{origin}/integrate/claude"
      target="_blank"
      rel="noreferrer">Add this to Claude</a
    >.
  </p>
  <CopyBlock text="{origin}/llms-full.txt" wrap />
</div>

{#if $keysQ.loading}
  <Skeleton height="3.5rem" lines={2} />
{:else if $keysQ.error}
  <p class="text-sm text-danger" role="alert">Couldn’t load your tokens.</p>
{:else if !keys.length}
  <EmptyState
    icon={KeyRound}
    title="No tokens yet"
    description="Create one for a script, a CI job or Claude. An agent’s token is made on the agent’s page."
  >
    {#snippet action()}<Button icon={Plus} onclick={() => openCreate()}>New token</Button>{/snippet}
  </EmptyState>
{:else}
  <div class="mb-3 flex flex-wrap items-center gap-3 text-sm">
    <label class="flex items-center gap-2">
      <span class="text-muted">Board</span>
      <select
        bind:value={boardFilter}
        class="h-8 rounded-md border border-line bg-surface px-2 text-sm"
      >
        <option value="all">All boards</option>
        {#each activeBoards as b (b.id)}<option value={b.id}>{b.key} · {b.name}</option>{/each}
      </select>
    </label>
    {#if inactiveCount}
      <label class="flex items-center gap-1.5 text-muted">
        <input type="checkbox" bind:checked={showInactive} class="accent-[var(--tm-accent)]" /> Show
        revoked & expired ({inactiveCount})
      </label>
    {/if}
  </div>
  {#snippet tokenRow(k: WithId<ApiKey>)}
    {@const st = keyState(k)}
    <li
      class="flex flex-wrap items-center gap-3 px-4 py-3 {st === 'active' ? '' : 'opacity-60'}"
      data-token-row={k.id}
    >
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <p class="flex flex-wrap items-center gap-2">
          <span class="font-medium">{k.name}</span>
          <code class="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">{k.prefix}…</code>
          <!-- §R1: account tokens are marked clearly, wherever they appear. -->
          {#if apiKeyKind(k) === 'account'}
            <Badge tone="accent">{tokenKindLabel('account')}</Badge>
          {/if}
          <!-- §AA6: a board token still acting as an agent, not converted yet. -->
          {#if isAgentKey(k) && apiKeyKind(k) === 'board'}
            <Badge>Older board token</Badge>
          {/if}
          {#if st === 'revoked'}<Badge tone="danger">{revokedReasonLabel(k.revokedReason)}</Badge
            >{:else if st === 'expired'}<Badge tone="warning">Expired</Badge>{/if}
        </p>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span class="flex items-center gap-1">
            Acts as
            {#if k.actsAs?.kind === 'agent'}
              <Principal id={k.actsAs.id} layout="compact" size={16} />
            {:else}
              <Principal id={auth.uid} layout="compact" size={16} suffix="(you)" />
            {/if}
            {#if apiKeyKind(k) === 'account'}<span>on every board you are on</span>{/if}
            {#if apiKeyKind(k) === 'agent'}<span>on every board and artifact it is on</span>{/if}
            {#if isAgentKey(k) && apiKeyKind(k) === 'board' && k.boardId}
              <span>on {boardName(k.boardId)}</span>
            {/if}
          </span>
          {#if apiKeyKind(k) === 'agent'}
            <!-- §AA1: no checkbox list — the role on each board decides. -->
            <span>Its roles decide what it may do</span>
            {#if k.defaultBoardId}<span>default board {boardKey(k.defaultBoardId)}</span>{/if}
          {:else}
            <span title={scopesTooltip(k.scopes)} class="cursor-help underline decoration-dotted"
              >{scopesSummary(k.scopes)}</span
            >
          {/if}
        </div>
        <p class="text-xs text-subtle">
          Created {dateOnly(k.createdAt, tz)} ·
          {k.lastUsedAt ? `last used ${relativeTime(k.lastUsedAt)}` : 'never used'} ·
          {#if k.expiresAt}{st === 'expired' ? 'expired' : 'expires'}
            {dateOnly(k.expiresAt, tz)}{:else}<span
              class={apiKeyKind(k) === 'account' ? 'text-danger' : ''}>never expires</span
            >{/if}
        </p>
      </div>
      {#if isAgentKey(k) && k.actsAs.kind === 'agent'}
        <!-- §AA5: read-only here — generate, replace and revoke on the agent's page. -->
        <Button size="sm" variant="ghost" href={agentRoutes.agent(k.actsAs.id)}
          >Manage on the agent’s page</Button
        >
      {:else if st === 'active'}
        <Button
          size="sm"
          variant="ghost"
          class="text-danger"
          onclick={() => {
            target = k;
            revokeOpen = true;
          }}>Revoke</Button
        >
      {/if}
    </li>
  {/snippet}

  {#if !groups.length && !accountKeys.length && !agentKeys.length}
    <p class="text-sm text-muted">No active tokens here.</p>
  {/if}
  <div class="flex flex-col gap-5" data-token-list>
    <!--
        §R1 — account tokens first, on their own: they belong to no board, and
        the board filter never hides them, because they can reach every board.
      -->
    {#if accountKeys.length}
      <section class="flex flex-col gap-1.5" data-account-tokens>
        <h3 class="flex items-center gap-2 text-sm font-medium">
          <Globe size={16} class="text-muted" aria-hidden="true" />
          Your whole account
          <span class="font-normal text-subtle">{accountKeys.length}</span>
        </h3>
        <ul class="divide-y divide-line rounded-xl border border-accent/40 bg-surface">
          {#each accountKeys as k (k.id)}{@render tokenRow(k)}{/each}
        </ul>
        <p class="text-xs text-muted">
          Each of these acts as you on every board you are on right now — and on none you have left.
        </p>
      </section>
    {/if}
    <!--
        §AA5 — agent tokens, read-only. One per agent; while converted older
        tokens are still about an agent has several rows, and its page is
        where "Revoke older tokens" is.
      -->
    {#if agentKeys.length}
      <section class="flex flex-col gap-1.5" data-agent-tokens>
        <h3 class="flex items-center gap-2 text-sm font-medium">
          <Bot size={16} class="text-muted" aria-hidden="true" />
          Your agents
          <span class="font-normal text-subtle">{agentKeys.length}</span>
        </h3>
        <ul class="divide-y divide-line rounded-xl border border-line bg-surface">
          {#each agentKeys as k (k.id)}{@render tokenRow(k)}{/each}
        </ul>
        <p class="text-xs text-muted">
          Each agent has one token. What it may do is set on the agent’s page: a role on each board,
          a permission on each artifact.
        </p>
      </section>
    {/if}
    {#each groups as g (g.boardId)}
      <section class="flex flex-col gap-1.5">
        <h3 class="flex items-center gap-2 text-sm font-medium">
          <span class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted"
            >{boardKey(g.boardId)}</span
          >
          {boardName(g.boardId)}
          <span class="font-normal text-subtle">{g.list.length}</span>
        </h3>
        <ul class="divide-y divide-line rounded-xl border border-line bg-surface">
          {#each g.list as k (k.id)}{@render tokenRow(k)}{/each}
        </ul>
      </section>
    {/each}
  </div>
{/if}

<Dialog
  bind:open={createOpen}
  title={created ? 'Copy your token now' : 'New token'}
  size="lg"
  dismissible={!created}
>
  {#if created}
    <TokenCreated
      token={created.key}
      apiBase={base}
      name={created.name}
      actsAs="you"
      boardName={created.boardName}
      kind={created.kind}
      boardCount={created.boardCount}
    />
  {:else if !activeBoards.length && !$boardsQ.loading}
    <p class="text-sm text-muted">You need to be on a board to create a token.</p>
  {:else}
    <TokenForm bind:draft boards={activeBoards} {touched} onsubmit={create} />
  {/if}
  {#snippet footer()}
    {#if created}
      <Button variant="primary" onclick={() => (createOpen = false)}>I’ve copied it</Button>
    {:else}
      <Button variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
      <Button
        type="submit"
        form="token-form"
        variant="primary"
        loading={creating}
        disabled={!activeBoards.length}>Create token</Button
      >
    {/if}
  {/snippet}
</Dialog>

<Dialog bind:open={revokeOpen} title="Revoke {target?.name ?? 'this token'}?" size="sm">
  <p class="text-sm">Anything using it stops working on its next request. This can’t be undone.</p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (revokeOpen = false)}>Cancel</Button>
    <Button variant="danger" loading={revoking} onclick={revoke}>Revoke token</Button>
  {/snippet}
</Dialog>

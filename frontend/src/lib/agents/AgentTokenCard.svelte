<!--
  The agent's page › TOKEN (agents.html §AA1, §AA5). An agent has ONE token: it
  says who the agent is and nothing else — no board, no checkbox list. What the
  agent may do is set in the Access card beside this one.

    none      → "Generate token"
    one       → name · prefix · created · last used, "Regenerate" (a confirm
                that says plainly the current token stops working at once) and
                Revoke
    several   → converted older tokens (§AA6) are still about: every live one
                is listed (with its old board as "default board"), "2 older
                tokens still work", "Revoke older tokens", and a per-row Revoke

  The secret is shown ONCE, in the same "shown once" dialog the Tokens page
  uses (TokenCreated), with the TM_TOKEN=… line.

  apiKeyCreate { kind: 'agent', actsAs: { kind: 'agent', id }, name } — the
  server revokes the agent's other live tokens in the same transaction
  (revokedReason 'rotated'); keepOthers is never sent from here. Tokens are my
  users/{uid}/apiKeys rows — the same live query Account › Tokens reads.
-->
<script lang="ts">
  import { env } from '$env/dynamic/public';
  import { KeyRound, RefreshCw } from 'lucide-svelte';
  import { apiKeyKind, paths, type ApiKey } from '@tm/shared';
  import { dateOnly, relativeTime } from '$lib/account/format';
  import TokenCreated from '$lib/account/TokenCreated.svelte';
  import { apiBase } from '$lib/account/tokens';
  import { command } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { principalLabel } from '$lib/people';
  import { myBoards, queryStore, type WithId } from '$lib/stores';
  import { Badge, Button, Dialog, EmptyState, Skeleton, toast } from '$lib/ui';
  import { agentTokenRequest, agentTokens, olderTokensLabel } from './access';

  interface Props {
    agentId: string;
    name: string;
    archived: boolean;
  }
  let { agentId, name, archived }: Props = $props();

  const keysQ = $derived(queryStore<ApiKey>(auth.uid ? { path: paths.apiKeys(auth.uid) } : null));
  const tokens = $derived(agentTokens($keysQ.data, agentId));
  const boardsQ = $derived(myBoards(auth.uid));
  const boardLabel = (id: string) => {
    const b = $boardsQ.data.find((x) => x.id === id);
    return b ? `${b.key} · ${b.name}` : 'a board you left';
  };
  const tz = $derived(auth.profile?.timezone);
  const base = $derived(
    apiBase(env.PUBLIC_API_BASE, typeof location === 'undefined' ? '' : location.origin),
  );

  // ── generate / regenerate ──
  let confirmOpen = $state(false);
  let creating = $state(false);
  /** The one time the key is visible. */
  let created = $state<{ key: string; name: string; rotated: number } | null>(null);
  let createdOpen = $state(false);

  function ask() {
    // Nothing to lose when there is no token yet: no confirm, just make it.
    if (tokens.live.length) confirmOpen = true;
    else void generate();
  }
  async function generate() {
    if (creating || archived) return;
    creating = true;
    try {
      const req = agentTokenRequest(agentId, name);
      const r = await command('apiKeyCreate', req, { toast: 'Could not generate the token' });
      created = { key: r.key, name: req.name, rotated: r.rotated ?? 0 };
      confirmOpen = false;
      createdOpen = true;
    } catch {
      /* toasted */
    } finally {
      creating = false;
    }
  }
  function doneCopying() {
    createdOpen = false;
    created = null; // the secret does not outlive the dialog
  }

  // ── revoke: one row, or every older one ──
  type Target = { mode: 'one'; key: WithId<ApiKey> } | { mode: 'older' };
  let target = $state<Target | null>(null);
  let revokeOpen = $state(false);
  let revoking = $state(false);

  function askRevoke(t: Target) {
    target = t;
    revokeOpen = true;
  }
  async function revokeKey(k: WithId<ApiKey>): Promise<boolean> {
    if (!auth.uid) return false;
    try {
      await command(
        'apiKeyRevoke',
        { keyId: k.id },
        {
          optimistic: {
            path: paths.apiKey(auth.uid, k.id),
            patch: { revokedAt: Date.now(), revokedReason: 'owner' },
          },
          toast: `Could not revoke ${k.name}`,
        },
      );
      return true;
    } catch {
      return false; // toasted
    }
  }
  async function revoke() {
    const t = target;
    if (!t || revoking) return;
    revoking = true;
    // Snapshot the list first: each revoke changes what `tokens` says.
    const list = t.mode === 'one' ? [t.key] : [...tokens.older];
    let done = 0;
    for (const k of list) if (await revokeKey(k)) done++;
    revoking = false;
    if (done === list.length) revokeOpen = false;
    if (done)
      toast.success(
        t.mode === 'one'
          ? `${t.key.name} revoked`
          : `${done} older token${done === 1 ? '' : 's'} revoked`,
      );
  }
</script>

{#snippet row(k: WithId<ApiKey>, isCurrent: boolean)}
  <li class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm" data-token-row={k.id}>
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <p class="flex flex-wrap items-center gap-2">
        <span class="font-medium">{k.name}</span>
        <code class="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">{k.prefix}…</code>
        {#if tokens.older.length}
          {#if isCurrent}<Badge tone="accent">Newest</Badge>{:else}<Badge>Older</Badge>{/if}
        {/if}
        <!-- §AA6: not converted yet — still a board token, still works on that one board. -->
        {#if apiKeyKind(k) === 'board'}<Badge tone="warning">Board token</Badge>{/if}
      </p>
      <p class="text-xs text-subtle">
        Created {dateOnly(k.createdAt, tz)} ·
        {k.lastUsedAt ? `last used ${relativeTime(k.lastUsedAt)}` : 'never used'}
        {#if k.expiresAt}
          · expires {dateOnly(k.expiresAt, tz)}{/if}
        {#if k.defaultBoardId}
          · default board {boardLabel(k.defaultBoardId)}
        {:else if apiKeyKind(k) === 'board' && k.boardId}
          · works on {boardLabel(k.boardId)} only
        {/if}
      </p>
    </div>
    <Button
      size="sm"
      variant="ghost"
      class="text-danger"
      onclick={() => askRevoke({ mode: 'one', key: k })}>Revoke</Button
    >
  </li>
{/snippet}

{#if $keysQ.loading}
  <Skeleton lines={1} height="3rem" />
{:else if $keysQ.error}
  <p class="text-sm text-danger" role="alert">Couldn’t load this agent’s token.</p>
{:else if !tokens.current}
  <EmptyState
    icon={KeyRound}
    title="No token yet"
    description={archived
      ? 'An archived agent has no token. Restore it to generate one.'
      : 'Generate the token your orchestrator signs in with. It is shown once.'}
  >
    {#snippet action()}
      {#if !archived}
        <Button variant="primary" icon={KeyRound} loading={creating} onclick={() => ask()}
          >Generate token</Button
        >
      {/if}
    {/snippet}
  </EmptyState>
{:else}
  <ul class="divide-y divide-line rounded-lg border border-line" data-agent-token>
    {#each tokens.live as k, i (k.id)}{@render row(k, i === 0)}{/each}
  </ul>

  {#if tokens.older.length}
    <!-- §AA5: "2 older tokens still work" — until the agent's callers use one token. -->
    <div
      class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning"
      data-older-tokens
    >
      <p class="min-w-0 flex-1">
        <strong>{olderTokensLabel(tokens.older.length)}.</strong>
        They are from before each agent had one token. When everything that runs this agent uses the newest
        one, revoke the rest.
      </p>
      <Button size="sm" onclick={() => askRevoke({ mode: 'older' })}>Revoke older tokens</Button>
    </div>
  {/if}

  <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
    {#if !archived}
      <Button icon={RefreshCw} loading={creating && !confirmOpen} onclick={() => ask()}
        >Regenerate</Button
      >
    {/if}
    <p class="min-w-0 flex-1 text-xs text-muted">
      Set it where the agent runs as <code>TM_TOKEN=…</code>. It reaches every board and artifact in
      Access below, and nothing else. We store a hash, so it can’t be shown again — regenerate if it
      is lost.
    </p>
  </div>
{/if}

<Dialog bind:open={confirmOpen} title="Regenerate {name}’s token?" size="sm">
  <p class="text-sm">
    {#if tokens.live.length > 1}
      <strong>All {tokens.live.length} tokens this agent has now stop working at once.</strong>
    {:else}
      <strong>The current token stops working at once.</strong>
    {/if}
    Anything still using {tokens.live.length > 1 ? 'one of them' : 'it'} is refused on its next request,
    until you give it the new one.
  </p>
  <p class="mt-2 text-sm text-muted">
    The new token is shown once. The agent’s boards, roles and artifacts do not change.
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (confirmOpen = false)}>Cancel</Button>
    <Button variant="danger" loading={creating} onclick={() => generate()}>Regenerate token</Button>
  {/snippet}
</Dialog>

<Dialog
  bind:open={createdOpen}
  title="Copy your token now"
  size="lg"
  dismissible={false}
  onclose={() => doneCopying()}
>
  {#if created}
    {#if created.rotated}
      <p class="mb-3 text-sm text-muted" data-rotated>
        {created.rotated === 1
          ? 'The previous token has stopped working.'
          : `The ${created.rotated} previous tokens have stopped working.`}
      </p>
    {/if}
    <TokenCreated
      token={created.key}
      apiBase={base}
      name={created.name}
      actsAs={principalLabel({ name, kind: 'agent' })}
      kind="agent"
    />
  {/if}
  {#snippet footer()}
    <Button variant="primary" onclick={() => doneCopying()}>I’ve copied it</Button>
  {/snippet}
</Dialog>

<Dialog
  bind:open={revokeOpen}
  title={target?.mode === 'older'
    ? `Revoke ${tokens.older.length} older token${tokens.older.length === 1 ? '' : 's'}?`
    : `Revoke ${target?.mode === 'one' ? target.key.name : 'this token'}?`}
  size="sm"
>
  {#if target?.mode === 'older'}
    <p class="text-sm">
      Every token of {name} except the newest (<code>{tokens.current?.prefix}…</code>) stops working
      on its next request. This can’t be undone.
    </p>
    <ul class="mt-2 list-disc pl-5 text-sm text-muted">
      {#each tokens.older as k (k.id)}
        <li>
          {k.name} <code>{k.prefix}…</code> ·
          {k.lastUsedAt ? `last used ${relativeTime(k.lastUsedAt)}` : 'never used'}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-sm">
      Anything using it stops working on its next request. This can’t be undone.
      {#if tokens.live.length === 1}
        {name} will have no token until you generate one.{/if}
    </p>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (revokeOpen = false)}>Cancel</Button>
    <Button variant="danger" loading={revoking} onclick={() => revoke()}
      >{target?.mode === 'older' ? 'Revoke older tokens' : 'Revoke token'}</Button
    >
  {/snippet}
</Dialog>

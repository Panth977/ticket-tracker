<!--
  Tokens that act as this agent (agents.html §B, §E): my apiKeys whose actsAs
  is this agent. Revoking happens in Account › Tokens; a new one opens that
  form prefilled with this agent.
-->
<script lang="ts">
  import { KeyRound, Plus } from 'lucide-svelte';
  import { paths, type ApiKey } from '@tm/shared';
  import { dateOnly, relativeTime } from '$lib/account/format';
  import { keyState, scopesSummary, revokedReasonLabel } from '$lib/account/tokens';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { myBoards, queryStore } from '$lib/stores';
  import { Badge, Button, EmptyState, Skeleton } from '$lib/ui';
  import { tokensOfAgent } from './agents';
  import { agentRoutes } from './routes';

  let { agentId, archived }: { agentId: string; archived: boolean } = $props();

  const keysQ = $derived(queryStore<ApiKey>(auth.uid ? { path: paths.apiKeys(auth.uid) } : null));
  const keys = $derived(tokensOfAgent($keysQ.data, agentId));
  const boardsQ = $derived(myBoards(auth.uid));
  const boardName = (id: string) =>
    $boardsQ.data.find((b) => b.id === id)?.name ?? 'a board you left';
  const tz = $derived(auth.profile?.timezone);
</script>

{#if $keysQ.loading}
  <Skeleton lines={2} height="2.5rem" />
{:else if !keys.length}
  <EmptyState
    icon={KeyRound}
    title="No tokens act as it"
    description="Create a token for one of its boards and give it to your orchestrator."
  >
    {#snippet action()}
      {#if !archived}<Button icon={Plus} href={agentRoutes.newToken({ agentId })}>New token</Button
        >{/if}
    {/snippet}
  </EmptyState>
{:else}
  <ul class="divide-y divide-line rounded-lg border border-line" data-agent-tokens>
    {#each keys as k (k.id)}
      {@const st = keyState(k)}
      <li
        class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm {st === 'active'
          ? ''
          : 'opacity-60'}"
      >
        <span class="font-medium">{k.name}</span>
        <code class="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">{k.prefix}…</code>
        <!-- Every token that acts as an agent names a board (§R1: an account
             token always acts as you), so boardId is never null here. -->
        <span class="text-muted">{k.boardId ? boardName(k.boardId) : '—'}</span>
        {#if st === 'revoked'}<Badge tone="danger">{revokedReasonLabel(k.revokedReason)}</Badge
          >{:else if st === 'expired'}<Badge tone="warning">Expired</Badge>{/if}
        <span class="w-full text-xs text-subtle">
          {scopesSummary(k.scopes)} · {k.lastUsedAt
            ? `last used ${relativeTime(k.lastUsedAt)}`
            : 'never used'}
          {#if k.expiresAt && st === 'active'}
            · expires {dateOnly(k.expiresAt, tz)}{/if}
        </span>
      </li>
    {/each}
  </ul>
  <div class="flex gap-2">
    {#if !archived}<Button size="sm" icon={Plus} href={agentRoutes.newToken({ agentId })}
        >New token</Button
      >{/if}
    <Button size="sm" variant="ghost" href={routes.account('tokens')}>Manage tokens</Button>
  </div>
{/if}

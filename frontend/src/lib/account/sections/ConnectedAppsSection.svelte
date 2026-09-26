<!--
  Account › Connected apps: every OAuth grant you approved on /oauth/consent
  (Claude, Cursor, Zapier…). Revoking deletes the grant and every token
  issued under it (grantRevoke) — the app is signed out at once.
-->
<script lang="ts">
  import { Plug } from 'lucide-svelte';
  import { paths, type OAuthGrant } from '@tm/shared';
  import { command } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { queryStore, type WithId } from '$lib/stores';
  import { Button, Dialog, EmptyState, Skeleton, toast } from '$lib/ui';
  import { dateOnly, relativeTime } from '../format';
  import { describeScopes } from '../scopes';
  import SectionHeader from '../SectionHeader.svelte';

  const grantsQ = $derived(
    queryStore<OAuthGrant>(
      auth.uid ? { path: paths.oauthGrants(auth.uid), orderBy: [['createdAt', 'desc']] } : null,
    ),
  );

  let target = $state<WithId<OAuthGrant> | null>(null);
  let open = $state(false);
  let busy = $state(false);

  async function revoke() {
    if (!target || !auth.uid) return;
    busy = true;
    const g = target;
    try {
      await command(
        'grantRevoke',
        { grantId: g.id },
        {
          optimistic: { path: paths.oauthGrant(auth.uid, g.id), patch: null },
          toast: 'Could not disconnect',
        },
      );
      toast.success(`${g.clientName} disconnected`);
      open = false;
    } catch {
      /* rolled back + toasted */
    } finally {
      busy = false;
    }
  }
</script>

<SectionHeader
  title="Connected apps"
  description="Apps you allowed to use TaskManager as you — AI assistants over MCP, automations. They can never do more than you can."
/>

{#if $grantsQ.loading}
  <Skeleton height="3.5rem" lines={2} />
{:else if $grantsQ.error}
  <p class="text-sm text-danger" role="alert">Couldn’t load your connected apps.</p>
{:else if !$grantsQ.data.length}
  <EmptyState
    icon={Plug}
    title="No connected apps"
    description="When an app such as Claude asks to use your account and you allow it, it shows up here."
  />
{:else}
  <ul class="divide-y divide-line rounded-xl border border-line bg-surface">
    {#each $grantsQ.data as g (g.id)}
      <li class="flex flex-wrap items-center gap-3 px-4 py-3">
        <span
          class="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 font-semibold text-muted"
          aria-hidden="true"
        >
          {g.clientName.slice(0, 1).toUpperCase()}
        </span>
        <div class="min-w-0 flex-1">
          <p class="font-medium">{g.clientName}</p>
          <p class="text-xs text-muted">{describeScopes(g.scopes) || 'No permissions'}</p>
          <p class="text-xs text-subtle">
            Connected {dateOnly(g.createdAt, auth.profile?.timezone)} · last used {relativeTime(
              g.lastUsedAt,
            )}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          class="text-danger"
          onclick={() => {
            target = g;
            open = true;
          }}>Revoke</Button
        >
      </li>
    {/each}
  </ul>
{/if}

<Dialog bind:open title="Disconnect {target?.clientName ?? 'this app'}?" size="sm">
  <p class="text-sm">It loses access right away. To use it again, you’ll approve it again.</p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="danger" loading={busy} onclick={revoke}>Revoke access</Button>
  {/snippet}
</Dialog>

<!--
  One pending invitation with Accept / Decline right in the row (Welcome,
  Boards home). Accepting joins the board (inviteAccept); the invite then
  drops out of the live myInvites() query by itself.
-->
<script lang="ts">
  import { Mail } from 'lucide-svelte';
  import type { Invite } from '@tm/shared';
  import { command } from '$lib/api';
  import type { WithId } from '$lib/stores';
  import { Badge, Button, toast } from '$lib/ui';
  import { ROLE_LABELS } from './inviteDraft';
  import { relativeTime } from './format';

  interface Props {
    invite: WithId<Invite>;
    onaccepted?: (r: { boardId: string; boardKey: string }) => void;
    compact?: boolean;
  }
  let { invite, onaccepted, compact = false }: Props = $props();
  let busy = $state<'accept' | 'decline' | null>(null);

  async function answer(accept: boolean) {
    busy = accept ? 'accept' : 'decline';
    try {
      const r = await command(
        'inviteAccept',
        { inviteId: invite.id, accept },
        { toast: accept ? 'Could not join the board' : 'Could not decline' },
      );
      if (accept) {
        toast.success(`You joined ${invite.boardName}`);
        onaccepted?.(r);
      } else toast.info(`Declined ${invite.boardName}`);
    } catch {
      /* toasted */
    } finally {
      busy = null;
    }
  }
</script>

<div
  class="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3"
  data-invite={invite.id}
>
  {#if !compact}
    <span
      class="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"
      aria-hidden="true"
    >
      <Mail size={16} />
    </span>
  {/if}
  <div class="min-w-0 flex-1">
    <p class="text-sm">
      <span class="font-medium">{invite.invitedByName || 'Someone'}</span> invited you to
      <span class="font-medium"
        >{#if !invite.artifactId}<span class="font-mono text-muted">{invite.boardKey}</span> ·
        {/if}{invite.boardName}</span
      >
      as <Badge tone="accent">{ROLE_LABELS[invite.role]}</Badge>
    </p>
    {#if invite.message}
      <p class="mt-1 line-clamp-2 text-sm text-muted">“{invite.message}”</p>
    {/if}
    <p class="mt-0.5 text-xs text-subtle">{relativeTime(invite.createdAt)}</p>
  </div>
  <div class="flex gap-2">
    <Button
      variant="ghost"
      size="sm"
      loading={busy === 'decline'}
      disabled={busy !== null}
      onclick={() => answer(false)}
    >
      Decline
    </Button>
    <Button
      variant="primary"
      size="sm"
      loading={busy === 'accept'}
      disabled={busy !== null}
      onclick={() => answer(true)}
    >
      Accept
    </Button>
  </div>
</div>

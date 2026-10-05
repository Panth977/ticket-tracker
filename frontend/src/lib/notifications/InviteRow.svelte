<!--
  An invitation in the Inbox: "Priya invited you to Engineering (ENG) as editor"
  with Accept / Decline right in the row (inviteAccept, accept: true|false).
  The invite document (invites/{id}, readable by my verified email) is the
  truth; the inbox row, if any, is archived once I answer.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { Mail } from 'lucide-svelte';
  import type { Invite } from '@tm/shared';
  import { command } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import { setFlags } from './actions';
  import { timeAgo } from './inbox';

  interface Props {
    invite: Invite & { id: string };
    /** Inbox rows standing for this invite — archived after answering. */
    inboxIds?: string[];
    now: number;
    selected?: boolean;
    unread?: boolean;
    onselect?: () => void;
  }
  let { invite, inboxIds = [], now, selected = false, unread = true, onselect }: Props = $props();

  let busy = $state<'accept' | 'decline' | null>(null);

  async function answer(accept: boolean) {
    busy = accept ? 'accept' : 'decline';
    try {
      const res = await command(
        'inviteAccept',
        { inviteId: invite.id, accept },
        { toast: accept ? 'Could not accept the invitation' : 'Could not decline the invitation' },
      );
      if (auth.uid && inboxIds.length) {
        const t = Date.now();
        await setFlags(auth.uid, inboxIds, { readAt: t, archivedAt: t });
      }
      if (accept) {
        toast.show({
          kind: 'success',
          message: `You joined ${invite.boardName}`,
          // An invite to an ARTIFACT (artifacts.html §B) names no board: open the artifact.
          action: res.artifactId
            ? { label: 'Open', run: () => void goto(routes.artifact(res.artifactId!)) }
            : { label: 'Open board', run: () => void goto(routes.board(res.boardKey)) },
        });
      } else toast.info('Invitation declined');
    } catch {
      /* command() already toasted */
    } finally {
      busy = null;
    }
  }
  export function accept() {
    if (!busy) void answer(true);
  }
</script>

<div
  role="option"
  tabindex="-1"
  aria-selected={selected}
  data-inbox-row="invite:{invite.id}"
  onclick={() => onselect?.()}
  onkeydown={() => {}}
  class="relative flex flex-wrap items-center gap-3 border-b border-line px-3 py-2.5 {selected
    ? 'bg-accent-soft'
    : 'hover:bg-surface-2'}"
>
  <span
    class="absolute top-1/2 left-1 size-1.5 -translate-y-1/2 rounded-full {unread
      ? 'bg-accent'
      : ''}"
    aria-hidden="true"
  ></span>
  <span
    class="grid size-[26px] shrink-0 place-items-center rounded-full bg-accent-soft text-accent"
  >
    <Mail size={14} aria-hidden="true" />
  </span>
  <div class="min-w-0 flex-1">
    <p class="truncate text-sm {unread ? 'font-medium' : 'text-muted'}">
      {invite.invitedByName} invited you to <span class="font-semibold">{invite.boardName}</span>
      {#if !invite.artifactId}<span class="font-mono text-xs text-muted">{invite.boardKey}</span
        >{/if} as {invite.role}
    </p>
    {#if invite.message}<p class="truncate text-xs text-muted">“{invite.message}”</p>{/if}
  </div>
  <div class="flex shrink-0 items-center gap-1.5">
    <Button
      size="sm"
      variant="primary"
      loading={busy === 'accept'}
      disabled={!!busy}
      onclick={(e) => {
        e.stopPropagation();
        void answer(true);
      }}
    >
      Accept
    </Button>
    <Button
      size="sm"
      variant="ghost"
      loading={busy === 'decline'}
      disabled={!!busy}
      onclick={(e) => {
        e.stopPropagation();
        void answer(false);
      }}
    >
      Decline
    </Button>
  </div>
  <time
    class="w-10 shrink-0 text-right text-xs text-subtle"
    datetime={new Date(invite.createdAt).toISOString()}
  >
    {timeAgo(invite.createdAt, now)}
  </time>
</div>

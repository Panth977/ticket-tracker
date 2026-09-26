<!--
  An avatar for a principal id (a person or an agent — agents wear the bot
  mark), with name (+ email) in the tooltip:
    <PersonAvatar uid={u} size={24} suffix="is viewing" />
  A thin wrapper over $lib/people's PrincipalAvatar, kept so the drawer's
  call sites stay as they are.

  Phase 3 (§L3): an AGENT's avatar also carries its health dot on this ticket
  — pulsing green while it works, red when the beats stop — read from the
  board's single live-status listener (§W: one RTDB node per board, no extra
  query per avatar).
-->
<script lang="ts">
  import { isAgentId, PrincipalAvatar } from '$lib/people';
  import { boardAgentStatus } from '$lib/agents/agentStatus';
  import { healthClock, healthLook, statusOf } from '$lib/agents/health';
  import { maybeTicketCtx } from './context';

  interface Props {
    uid: string;
    size?: number;
    ring?: boolean;
    suffix?: string;
    /** Turn the health dot off (stacks of avatars, where it would be noise). */
    health?: boolean;
  }
  let { uid, size = 20, ring = false, suffix, health = true }: Props = $props();

  const t = maybeTicketCtx();
  const agent = $derived(isAgentId(uid));
  const statuses = $derived(boardAgentStatus(health && agent ? t?.boardId : null));
  const status = $derived(agent && t?.ticketId ? statusOf($statuses.data, uid, t.ticketId) : null);
  const look = $derived(healthLook(status, $healthClock, t?.tz));
  const dot = $derived(Math.max(6, Math.round(size * 0.3)));
</script>

{#if look.health !== 'none'}
  <span class="relative inline-flex" title={look.label} data-health={look.health}>
    <PrincipalAvatar id={uid} {size} {ring} {suffix} />
    <span
      class="absolute -top-0.5 -left-0.5 inline-flex"
      style="width:{dot}px;height:{dot}px"
      aria-label={look.label}
    >
      {#if look.pulse}
        <span
          class="absolute inline-flex size-full animate-ping rounded-full opacity-70 {look.dot} motion-reduce:hidden"
          aria-hidden="true"
        ></span>
      {/if}
      <span class="relative inline-flex size-full rounded-full ring-1 ring-surface {look.dot}"
      ></span>
    </span>
  </span>
{:else}
  <PrincipalAvatar id={uid} {size} {ring} {suffix} />
{/if}

<!--
  One agent's health (agents.html §L3), drawn from a status document the
  board's single agentStatus listener already has:

    <AgentHealth {status} />                🟢 Working · Running tests (3/12)
    <AgentHealth {status} dotOnly />        a bare dot, for a card
    <AgentHealth {status} name="Builder" /> 🟢 Builder · Working · …

  The colour, the words and the pulse all come from healthLook(), so nothing
  on screen can disagree about what an agent is doing. `none` (no status yet)
  renders nothing at all.
-->
<script lang="ts">
  import type { AgentStatus } from '@tm/shared';
  import type { WithId } from '$lib/stores';
  import { healthClock, healthLook } from './health';

  interface Props {
    status: WithId<AgentStatus> | AgentStatus | null | undefined;
    /** Just the dot (board cards, avatars). */
    dotOnly?: boolean;
    /** Put a name in front of the state. */
    name?: string;
    /** The viewer's time zone, for 'Finished · 10:42'. */
    tz?: string;
    size?: number;
    class?: string;
  }
  let { status, dotOnly = false, name, tz, size = 8, class: cls = '' }: Props = $props();

  const look = $derived(healthLook(status, $healthClock, tz));
  const full = $derived(name ? `${name} · ${look.label}` : look.label);
</script>

{#if look.health !== 'none'}
  {#if dotOnly}
    <span
      class="relative inline-flex shrink-0 {cls}"
      title={full}
      aria-label={full}
      data-health={look.health}
    >
      {#if look.pulse}
        <span
          class="absolute inline-flex size-full animate-ping rounded-full opacity-70 {look.dot} motion-reduce:hidden"
          aria-hidden="true"
        ></span>
      {/if}
      <span
        class="relative inline-flex rounded-full {look.dot}"
        style="width:{size}px;height:{size}px"
      ></span>
    </span>
  {:else}
    <span
      class="inline-flex min-w-0 items-center gap-1.5 text-xs {look.text} {cls}"
      data-health={look.health}
      title={full}
    >
      <span class="relative inline-flex shrink-0" aria-hidden="true">
        {#if look.pulse}
          <span
            class="absolute inline-flex size-full animate-ping rounded-full opacity-70 {look.dot} motion-reduce:hidden"
          ></span>
        {/if}
        <span
          class="relative inline-flex rounded-full {look.dot}"
          style="width:{size}px;height:{size}px"
        ></span>
      </span>
      <span class="min-w-0 truncate">
        {#if name}<span class="font-medium">{name}</span> ·
        {/if}{look.title}{#if look.detail}
          · {look.detail}{/if}
      </span>
    </span>
  {/if}
{/if}

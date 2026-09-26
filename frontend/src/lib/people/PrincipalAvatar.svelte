<!--
  One principal's picture — a person or an agent (agents wear a small bot mark
  in the corner). Name (+ email / 'agent') in the tooltip.
  <PrincipalAvatar id={uid} size={24} />   <PrincipalAvatar id={id} ring suffix="is viewing" />
-->
<script lang="ts">
  import { Bot } from 'lucide-svelte';
  import Avatar from '$lib/ui/Avatar.svelte';
  import { person } from './person';
  import { principalLabel } from './principal';

  interface Props {
    id: string;
    size?: number;
    /** Ring in the surface colour (for overlapping stacks). */
    ring?: boolean;
    suffix?: string;
    class?: string;
  }
  let { id, size = 20, ring = false, suffix, class: cls = '' }: Props = $props();
  const p = $derived(person(id));
  const agent = $derived($p.person?.kind === 'agent');
  const label = $derived(
    `${principalLabel($p.person)}${suffix ? ' ' + suffix : ''}${$p.person?.email ? ` (${$p.person.email})` : ''}`,
  );
  const mark = $derived(Math.max(10, Math.round(size * 0.45)));
</script>

<span
  class="relative inline-flex shrink-0 rounded-full {ring ? 'ring-2 ring-surface' : ''} {cls}"
  title={label}
>
  <Avatar
    src={$p.person?.avatarUrl}
    icon={$p.person?.icon}
    name={$p.person?.name ?? '?'}
    seed={id}
    {size}
  />
  {#if agent}
    <span
      class="absolute -right-0.5 -bottom-0.5 grid place-items-center rounded-full bg-accent text-accent-fg ring-1 ring-surface"
      style:width="{mark}px"
      style:height="{mark}px"
      aria-hidden="true"
      data-agent-mark
    >
      <Bot size={Math.max(7, mark - 4)} />
    </span>
  {/if}
</span>

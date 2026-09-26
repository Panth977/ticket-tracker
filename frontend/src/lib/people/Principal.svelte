<!--
  THE way a principal appears (agents.html §A): picture + name + email for a
  person; picture + name + Agent badge (+ owner) for an agent. Pass an id
  (looked up live via person(id)) or a ready Person.
  <Principal id={uid} />                     name + email / badge beside
  <Principal id={uid} layout="stacked" />    email / 'Agent · by Priya' under the name
  <Principal id={uid} layout="compact" />    picture + name (+ badge), detail in the tooltip
-->
<script lang="ts">
  import { Skeleton } from '$lib/ui';
  import AgentBadge from './AgentBadge.svelte';
  import OwnerName from './OwnerName.svelte';
  import PrincipalAvatar from './PrincipalAvatar.svelte';
  import Avatar from '$lib/ui/Avatar.svelte';
  import { person as personStore, type Person, type PersonState } from './person';
  import { principalDetail } from './principal';

  interface Props {
    id?: string | null;
    person?: Person;
    layout?: 'inline' | 'stacked' | 'compact';
    size?: number;
    /** e.g. '(you)' */
    suffix?: string;
    /** Stacked agents: show 'by {owner}' (default true). */
    showOwner?: boolean;
    class?: string;
  }
  let {
    id,
    person: given,
    layout = 'inline',
    size,
    suffix,
    showOwner = true,
    class: cls = '',
  }: Props = $props();

  const store = $derived(given ? null : personStore(id));
  let live = $state<PersonState>({ loading: true, person: null, error: null });
  $effect(() => {
    if (!store) return;
    return store.subscribe((s) => (live = s));
  });
  const p = $derived(given ?? live.person);
  const loading = $derived(!given && live.loading);
  const avatarSize = $derived(size ?? (layout === 'stacked' ? 32 : 20));
  const agent = $derived(p?.kind === 'agent');
  const detail = $derived(p ? principalDetail(p) : '');
</script>

{#if loading}
  <span class="inline-flex items-center gap-2 {cls}">
    <Skeleton class="rounded-full" width="{avatarSize}px" height="{avatarSize}px" />
    <Skeleton width="6rem" height="0.75rem" />
  </span>
{:else if !p}
  <span class="inline-flex items-center gap-2 text-muted {cls}">
    <Avatar name="?" size={avatarSize} decorative />
    <span class="text-sm">Unknown</span>
  </span>
{:else if layout === 'stacked'}
  <span class="inline-flex min-w-0 items-center gap-2.5 {cls}" data-principal={p.kind}>
    <PrincipalAvatar id={p.uid} size={avatarSize} />
    <span class="flex min-w-0 flex-col leading-tight">
      <span class="flex min-w-0 items-center gap-1.5">
        <span class="truncate text-sm font-medium"
          >{p.name}{#if suffix}<span class="text-muted"> {suffix}</span>{/if}</span
        >
        {#if agent}<AgentBadge />{/if}
      </span>
      {#if agent}
        <span class="truncate text-xs text-muted">
          {#if detail}{detail}{#if showOwner && p.ownerUid}
              ·
            {/if}{/if}{#if showOwner && p.ownerUid}by <OwnerName uid={p.ownerUid} />{/if}
        </span>
      {:else if detail}
        <span class="truncate text-xs text-muted">{detail}</span>
      {/if}
    </span>
  </span>
{:else}
  <span
    class="inline-flex min-w-0 items-center gap-1.5 {cls}"
    title={layout === 'compact' ? detail || undefined : undefined}
    data-principal={p.kind}
  >
    <PrincipalAvatar id={p.uid} size={avatarSize} />
    <span class="truncate text-sm"
      >{p.name}{#if suffix}<span class="text-muted"> {suffix}</span>{/if}</span
    >
    {#if agent}<AgentBadge compact={layout === 'compact'} />{/if}
    {#if layout === 'inline' && detail && !agent}<span class="truncate text-xs text-muted"
        >{detail}</span
      >{/if}
  </span>
{/if}

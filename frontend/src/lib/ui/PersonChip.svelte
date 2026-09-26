<!--
  How a person appears everywhere: picture + display name + email (two people
  named Priya are told apart by the email). Pass a uid (looked up live via
  person(uid)) or a ready person object.
  <PersonChip uid={t.assigneeUids[0]} />            name + email beside
  <PersonChip uid={uid} layout="stacked" />         email under the name
  <PersonChip uid={uid} layout="compact" />         picture + name, email in the tooltip
  With a uid it delegates to $lib/people's Principal, so an agent id shows its
  picture, bot mark and Agent badge wherever a person would (agents.html §A).
-->
<script lang="ts">
  import Principal from '$lib/people/Principal.svelte';
  import type { Person } from '$lib/people/person';
  import Avatar from './Avatar.svelte';

  interface Props {
    uid?: string | null;
    person?: Pick<Person, 'name' | 'email' | 'avatarUrl'> & { uid?: string; icon?: string | null };
    layout?: 'inline' | 'stacked' | 'compact';
    size?: number;
    /** e.g. '(you)' */
    suffix?: string;
    class?: string;
  }
  let { uid, person: p, layout = 'inline', size, suffix, class: cls = '' }: Props = $props();
  const avatarSize = $derived(size ?? (layout === 'stacked' ? 32 : 20));
</script>

{#if !p}
  <Principal id={uid} {layout} {size} {suffix} class={cls} />
{:else if layout === 'stacked'}
  <span class="inline-flex min-w-0 items-center gap-2.5 {cls}">
    <Avatar
      src={p.avatarUrl}
      icon={p.icon}
      name={p.name}
      seed={p.uid ?? uid ?? p.email}
      size={avatarSize}
      decorative
    />
    <span class="flex min-w-0 flex-col leading-tight">
      <span class="truncate text-sm font-medium"
        >{p.name}{#if suffix}<span class="text-muted"> {suffix}</span>{/if}</span
      >
      {#if p.email}<span class="truncate text-xs text-muted">{p.email}</span>{/if}
    </span>
  </span>
{:else}
  <span
    class="inline-flex min-w-0 items-center gap-1.5 {cls}"
    title={layout === 'compact' ? p.email : undefined}
  >
    <Avatar
      src={p.avatarUrl}
      icon={p.icon}
      name={p.name}
      seed={p.uid ?? uid ?? p.email}
      size={avatarSize}
      decorative
    />
    <span class="truncate text-sm"
      >{p.name}{#if suffix}<span class="text-muted"> {suffix}</span>{/if}</span
    >
    {#if layout === 'inline' && p.email}<span class="truncate text-xs text-muted">{p.email}</span
      >{/if}
  </span>
{/if}

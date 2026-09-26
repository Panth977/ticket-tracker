<!-- '@Priya Shah' — a mention stores the principal id and renders its current name (email in the tooltip; agents resolve through $lib/people and get the badge). -->
<script lang="ts">
  import AgentBadge from '$lib/people/AgentBadge.svelte';
  import { person } from '$lib/people/person';

  let { uid }: { uid: string } = $props();
  const p = $derived(person(uid));
</script>

<span title={$p.person?.email || $p.person?.description || undefined}
  >@{$p.person?.name ??
    ($p.loading ? '…' : 'someone')}{#if $p.person?.kind === 'agent'}&nbsp;<AgentBadge
      compact
    />{/if}</span
>

<!-- A principal's current name for an id: <PrincipalName id={u} /> (agents get the badge; email in the tooltip). -->
<script lang="ts">
  import AgentBadge from './AgentBadge.svelte';
  import { person } from './person';

  let {
    id,
    badge = true,
    class: cls = 'font-medium',
  }: { id: string; badge?: boolean; class?: string } = $props();
  const p = $derived(person(id));
</script>

<span class="inline-flex items-center gap-1"
  ><span class={cls} title={$p.person?.email || $p.person?.description || undefined}
    >{$p.person?.name ?? ($p.loading ? '…' : 'Someone')}</span
  >{#if badge && $p.person?.kind === 'agent'}<AgentBadge compact />{/if}</span
>

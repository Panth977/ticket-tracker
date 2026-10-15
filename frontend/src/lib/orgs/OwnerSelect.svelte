<!--
  Who a new board / artifact / bucket will belong to (agents.html §AC): you,
  or an org you are in. Bound as 'user:{uid}' / 'org:{id}'; ownerOf() turns
  it into the command's `owner`.
-->
<script lang="ts">
  import { auth } from '$lib/firebase/auth.svelte';
  import Select from '$lib/ui/Select.svelte';
  import { myOrgs } from './store';

  let { value = $bindable('') }: { value: string } = $props();
  const orgsQ = $derived(myOrgs(auth.uid));
  const options = $derived([
    { value: `user:${auth.uid ?? ''}`, label: 'You' },
    ...[...$orgsQ.data]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((o) => ({ value: `org:${o.id}`, label: `${o.name} (org)` })),
  ]);
  $effect(() => {
    if (!value && auth.uid) value = `user:${auth.uid}`;
  });
</script>

{#if $orgsQ.data.length}
  <Select label="Owner" {options} bind:value hint="An org's members reach everything it owns." />
{/if}

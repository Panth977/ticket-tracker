<!-- 'yours' / 'Priya's' — who owns an agent. <OwnerName uid={p.ownerUid} /> -->
<script lang="ts">
  import { auth } from '$lib/firebase/auth.svelte';
  import { person } from './person';

  let { uid }: { uid: string | null | undefined } = $props();
  const p = $derived(person(uid && uid !== auth.uid ? uid : null));
</script>

{#if uid && uid === auth.uid}you{:else if uid}{$p.person?.name ?? '…'}{:else}someone{/if}

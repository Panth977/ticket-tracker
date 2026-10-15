<!-- A person's avatar by uid (their initials while the profile loads). -->
<script lang="ts">
  import Avatar from '$lib/ui/Avatar.svelte';
  import { person } from '$lib/people/person';
  let { uid, size = 16 }: { uid: string; size?: number } = $props();
  const p = $derived(person(uid));
</script>

<Avatar src={$p.person?.avatarUrl} name={$p.person?.name ?? uid} seed={uid} {size} decorative />

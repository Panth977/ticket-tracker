<!-- A person's display name by uid (falls back to the uid while it loads). -->
<script lang="ts">
  import { person } from '$lib/people/person';
  let { uid }: { uid: string } = $props();
  const p = $derived(person(uid));
</script>

{$p.person?.name ?? uid}

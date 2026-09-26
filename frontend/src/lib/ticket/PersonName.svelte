<!-- A principal's current name for an id: <PersonName uid={u} /> — delegates to $lib/people's PrincipalName (agents get the badge; email in the tooltip). -->
<script lang="ts">
  import { PrincipalName } from '$lib/people';

  let { uid, class: cls = 'font-medium' }: { uid: string; class?: string } = $props();
</script>

<PrincipalName id={uid} class={cls} />

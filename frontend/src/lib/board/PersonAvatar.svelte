<!--
  One principal's avatar (a person, or an agent wearing the bot mark), live
  from $lib/people; name in the tooltip. A thin wrapper over PrincipalAvatar so
  the board's call sites stay as they are (agents.html §A).
-->
<script lang="ts">
  import { PrincipalAvatar } from '$lib/people';

  interface Props {
    uid: string;
    size?: number;
    class?: string;
  }
  let { uid, size = 20, class: cls = '' }: Props = $props();
</script>

<PrincipalAvatar id={uid} {size} class={cls} />

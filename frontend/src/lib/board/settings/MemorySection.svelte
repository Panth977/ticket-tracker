<!-- Board settings › Memory (memory.html §D): admins grant their own memories to this board. -->
<script lang="ts">
  import MemoryGrants from '$lib/memoryRefs/MemoryGrants.svelte';
  import Section from './Section.svelte';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
</script>

{#if s.isAdmin}
  <MemoryGrants
    target={{ boardId: s.board.id }}
    description="Let this board use memories you own. Read: everyone on the board can browse them and attach their files to tickets. Read & write: editors and admins can also add and change files. Nobody gets more than their role here allows."
  />
{:else}
  <Section title="Memory" description="Which memories this board may use.">
    <p class="text-sm text-muted">Only board admins choose which memories this board uses.</p>
  </Section>
{/if}

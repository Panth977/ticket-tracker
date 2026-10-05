<!--
  Board settings › Memory (memory.html §D, §J): admins grant their own memories
  to this board, and pick which one (and at what path) ticket attachments go.
-->
<script lang="ts">
  import MemoryGrants from '$lib/memoryRefs/MemoryGrants.svelte';
  import AttachMemorySettings from './AttachMemorySettings.svelte';
  import Section from './Section.svelte';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
</script>

<div class="flex flex-col gap-10">
  {#if s.isAdmin}
    <MemoryGrants
      target={{ boardId: s.board.id }}
      attachMemoryId={s.board.attachMemory?.memoryId ?? null}
      description="Let this board use memories you own. Read: everyone on the board can browse them and attach their files to tickets. Read & write: editors and admins can also add and change files, and files put on tickets can go into it. Nobody gets more than their role here allows."
    />
  {:else}
    <Section title="Memory" description="Which memories this board may use.">
      <p class="text-sm text-muted">Only board admins choose which memories this board uses.</p>
    </Section>
  {/if}
  <AttachMemorySettings />
</div>

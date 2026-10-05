<!--
  Artifact settings › Memory (owner only, memory.html §D, §H): which of my
  memories the page may use through BackendDriver.memory.
-->
<script lang="ts">
  import MemoryGrants from '$lib/memoryRefs/MemoryGrants.svelte';
  import { useArtifactSettings } from './context.svelte';

  const s = useArtifactSettings();
</script>

<MemoryGrants
  target={{ artifactId: s.artifact.id }}
  description="Let this artifact read — or also change — files in memories you own, through BackendDriver.memory. Anyone you share it with reaches only what they already can in that memory."
/>

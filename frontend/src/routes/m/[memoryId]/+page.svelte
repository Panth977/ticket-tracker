<!-- /m/[memoryId] — one memory (docs/plan/memory.html §F); ?path= a file or folder in it. -->
<script lang="ts">
  import { page } from '$app/state';
  import MemoryBrowser from '$lib/memory/MemoryBrowser.svelte';

  const memoryId = $derived(page.params.memoryId ?? '');
</script>

{#key memoryId}
  <MemoryBrowser {memoryId} />
{/key}

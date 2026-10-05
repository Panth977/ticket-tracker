<!--
  /x/[artifactId] — one artifact, running (docs/plan/artifacts.html §D3).
  Keyed on the id: going from one artifact to another tears down the first
  one's iframe, broker and every listener it held before the next mounts.
-->
<script lang="ts">
  import { page } from '$app/state';
  import ArtifactHost from '$lib/artifacts/ArtifactHost.svelte';

  const artifactId = $derived(page.params.artifactId ?? '');
</script>

{#key artifactId}
  <ArtifactHost {artifactId} />
{/key}

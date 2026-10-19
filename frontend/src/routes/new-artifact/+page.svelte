<!-- /new-artifact — New artifact as a page of its own, like /new-board (lib/ui/CreatePage). -->
<script lang="ts">
  import { page } from '$app/state';
  import { APP_NAME } from '$lib/brand';
  import NewArtifactForm from '$lib/artifacts/NewArtifactForm.svelte';
</script>

<svelte:head><title>New artifact · {APP_NAME}</title></svelte:head>
<NewArtifactForm owner={page.url.searchParams.get('owner') ?? ''} />

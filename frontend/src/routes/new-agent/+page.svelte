<!-- /new-agent — New agent as a page of its own, like /new-board (lib/ui/CreatePage). -->
<script lang="ts">
  import { APP_NAME } from '$lib/brand';
  import NewAgentForm from '$lib/agents/NewAgentForm.svelte';
</script>

<svelte:head><title>New agent · {APP_NAME}</title></svelte:head>
<NewAgentForm />

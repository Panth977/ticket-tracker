<!-- /new-org — New org as a page of its own, like /new-board (lib/ui/CreatePage). -->
<script lang="ts">
  import { APP_NAME } from '$lib/brand';
  import NewOrgForm from '$lib/orgs/NewOrgForm.svelte';
</script>

<svelte:head><title>New org · {APP_NAME}</title></svelte:head>
<NewOrgForm />

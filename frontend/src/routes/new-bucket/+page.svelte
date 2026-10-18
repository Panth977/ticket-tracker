<!-- /new-bucket — New bucket as a page of its own, like /new-board (lib/ui/CreatePage). -->
<script lang="ts">
  import { page } from '$app/state';
  import { APP_NAME } from '$lib/brand';
  import NewBucketForm from '$lib/bucket/NewBucketForm.svelte';
</script>

<svelte:head><title>New bucket · {APP_NAME}</title></svelte:head>
<NewBucketForm owner={page.url.searchParams.get('owner') ?? ''} />

<!-- /new-dictionary — New dictionary as a page of its own, like /new-board (lib/ui/CreatePage). -->
<script lang="ts">
  import { page } from '$app/state';
  import { APP_NAME } from '$lib/brand';
  import NewDictionaryForm from '$lib/dictionary/NewDictionaryForm.svelte';
</script>

<svelte:head><title>New dictionary · {APP_NAME}</title></svelte:head>
<NewDictionaryForm owner={page.url.searchParams.get('owner') ?? ''} />

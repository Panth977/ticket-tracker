<!-- /bucket/[bucketId] — one bucket (docs/plan/bucket.html §F); ?path= a file or folder in it. -->
<script lang="ts">
  import { page } from '$app/state';
  import BucketBrowser from '$lib/bucket/BucketBrowser.svelte';

  const bucketId = $derived(page.params.bucketId ?? '');
</script>

{#key bucketId}
  <BucketBrowser {bucketId} />
{/key}

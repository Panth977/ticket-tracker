<!-- /dictionary/[dictionaryId] — one dictionary (docs/plan/dictionary.html): its entries. -->
<script lang="ts">
  import { page } from '$app/state';
  import DictionaryPage from '$lib/dictionary/DictionaryPage.svelte';

  const dictionaryId = $derived(page.params.dictionaryId ?? '');
</script>

{#key dictionaryId}
  <DictionaryPage {dictionaryId} />
{/key}

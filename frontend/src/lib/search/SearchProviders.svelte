<!--
  Renderless: keeps the Tickets + Commands ⌘K providers registered while
  mounted (reference-counted, so mounting it in several places is fine).
-->
<script lang="ts">
  import { retainSearchProviders } from './providers';

  $effect(() => retainSearchProviders());
</script>

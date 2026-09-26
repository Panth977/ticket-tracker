<!-- /b/[boardKey]/settings → the General section. -->
<script lang="ts">
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { routes } from '$lib/layout/routes';

  $effect(() => {
    void goto(routes.boardSettings(page.params.boardKey ?? '', 'general'), { replaceState: true });
  });
</script>

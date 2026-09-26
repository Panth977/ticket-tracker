<!--
  /b/[boardKey]/people — kept only as a redirect. People & roles is a section
  of board settings now (agents.html §Q2: "⚙ Settings is the only door to board
  configuration, and People & roles is a section inside it"). Links people
  already have — emails, bookmarks, an agent's board list — still land.
-->
<script lang="ts">
  // goto() targets are built by lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { routes } from '$lib/layout/routes';
  import Skeleton from '$lib/ui/Skeleton.svelte';

  $effect(() => {
    void goto(routes.boardSettings(page.params.boardKey ?? '', 'people'), { replaceState: true });
  });
</script>

<svelte:head><title>People — TaskManager</title></svelte:head>

<div class="flex flex-col gap-3 p-6" aria-busy="true" aria-label="Opening People &amp; roles">
  <Skeleton height="1.5rem" width="16rem" /><Skeleton lines={4} />
</div>

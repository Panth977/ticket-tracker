<!-- /x/[artifactId]/settings → the first section this role has (the layout sends viewers away). -->
<script lang="ts">
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { useArtifactSettings } from '$lib/artifacts/settings/context.svelte';
  import { firstSettingsSection } from '$lib/artifacts/store';
  import { routes } from '$lib/layout/routes';

  const s = useArtifactSettings();

  $effect(() => {
    const first = firstSettingsSection(s.role);
    if (first)
      void goto(routes.artifactSettings(page.params.artifactId ?? '', first), {
        replaceState: true,
      });
  });
</script>

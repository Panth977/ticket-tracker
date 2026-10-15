<!--
  "● Org ›" before a board's, an artifact's or a bucket's name when an org of
  mine owns it (agents.html §AC). One click to the org's page.
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { ChevronRight } from 'lucide-svelte';
  import type { Org } from '@tm/shared';
  import { routes } from '$lib/layout/routes';
  import Indicator from '$lib/ui/Indicator.svelte';
  import type { WithId } from '$lib/stores';

  let { org }: { org: WithId<Org> } = $props();
</script>

<a
  href={routes.owner(org.handle)}
  class="flex min-w-0 shrink items-center gap-1.5 truncate text-sm text-muted hover:text-text"
  data-org-crumb
>
  <Indicator of={org} seed={org.id} size="sm" />
  <span class="truncate">{org.name}</span>
</a>
<ChevronRight size={14} class="shrink-0 text-subtle" aria-hidden="true" />

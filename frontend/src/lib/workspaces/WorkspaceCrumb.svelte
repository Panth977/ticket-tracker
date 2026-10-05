<!--
  "● Workspace ›" before a board's or an artifact's name, while I am in that
  workspace (agents.html §AB3). One click back to the workspace page.
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { ChevronRight } from 'lucide-svelte';
  import type { Workspace } from '@tm/shared';
  import { routes } from '$lib/layout/routes';
  import Indicator from '$lib/ui/Indicator.svelte';
  import type { WithId } from '$lib/stores';

  let { workspace }: { workspace: WithId<Workspace> } = $props();
</script>

<a
  href={routes.workspace(workspace.id)}
  class="flex min-w-0 shrink items-center gap-1.5 truncate text-sm text-muted hover:text-text"
  data-workspace-crumb
>
  <Indicator of={workspace} seed={workspace.id} size="sm" />
  <span class="truncate">{workspace.name}</span>
</a>
<ChevronRight size={14} class="shrink-0 text-subtle" aria-hidden="true" />

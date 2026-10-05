<!-- /m/[memoryId]/settings/[section] — picks the section; the layout provides the memory. -->
<script lang="ts">
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { SearchX } from 'lucide-svelte';
  import GeneralSection from '$lib/memory/settings/GeneralSection.svelte';
  import PeopleSection from '$lib/memory/settings/PeopleSection.svelte';
  import SubscribersSection from '$lib/memory/settings/SubscribersSection.svelte';
  import { useMemorySettings } from '$lib/memory/settings/context.svelte';
  import { memorySettingsFor } from '$lib/memory/store';
  import { routes } from '$lib/layout/routes';
  import { Button, EmptyState } from '$lib/ui';

  const s = useMemorySettings();
  const section = $derived(page.params.section ?? '');
  const mine = $derived(memorySettingsFor(s.role).some((x) => x.id === section));
  // Renamed (lib/access): old links still land.
  const MOVED: Record<string, 'subscribers'> = { access: 'subscribers' };
  $effect(() => {
    const to = MOVED[section];
    if (to) void goto(routes.memorySettings(s.memory.id, to), { replaceState: true });
  });
</script>

{#key section}
  {#if section in MOVED}
    <!-- redirecting -->
  {:else if !mine}
    <EmptyState
      icon={SearchX}
      title="No such section"
      description="That part of the memory's settings doesn't exist, or isn't yours to change."
    >
      {#snippet action()}<Button href={routes.memorySettings(s.memory.id, 'subscribers')}
          >Go to settings</Button
        >{/snippet}
    </EmptyState>
  {:else if section === 'general'}
    <GeneralSection />
  {:else if section === 'people'}
    <PeopleSection />
  {:else if section === 'subscribers'}
    <SubscribersSection />
  {/if}
{/key}

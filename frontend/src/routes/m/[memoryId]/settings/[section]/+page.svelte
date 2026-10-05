<!-- /m/[memoryId]/settings/[section] — picks the section; the layout provides the memory. -->
<script lang="ts">
  import { page } from '$app/state';
  import { SearchX } from 'lucide-svelte';
  import AccessSection from '$lib/memory/settings/AccessSection.svelte';
  import GeneralSection from '$lib/memory/settings/GeneralSection.svelte';
  import PeopleSection from '$lib/memory/settings/PeopleSection.svelte';
  import { useMemorySettings } from '$lib/memory/settings/context.svelte';
  import { memorySettingsFor } from '$lib/memory/store';
  import { routes } from '$lib/layout/routes';
  import { Button, EmptyState } from '$lib/ui';

  const s = useMemorySettings();
  const section = $derived(page.params.section ?? '');
  const mine = $derived(memorySettingsFor(s.role).some((x) => x.id === section));
</script>

{#key section}
  {#if !mine}
    <EmptyState
      icon={SearchX}
      title="No such section"
      description="That part of the memory's settings doesn't exist, or isn't yours to change."
    >
      {#snippet action()}<Button href={routes.memorySettings(s.memory.id, 'access')}
          >Go to settings</Button
        >{/snippet}
    </EmptyState>
  {:else if section === 'general'}
    <GeneralSection />
  {:else if section === 'people'}
    <PeopleSection />
  {:else if section === 'access'}
    <AccessSection />
  {/if}
{/key}

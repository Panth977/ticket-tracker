<!-- /x/[artifactId]/settings/[section] — picks the section; the layout provides the artifact. -->
<script lang="ts">
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { SearchX } from 'lucide-svelte';
  import BuildsSection from '$lib/artifacts/settings/BuildsSection.svelte';
  import DataSection from '$lib/artifacts/settings/DataSection.svelte';
  import GeneralSection from '$lib/artifacts/settings/GeneralSection.svelte';
  import PeopleSection from '$lib/artifacts/settings/PeopleSection.svelte';
  import SubscribersSection from '$lib/artifacts/settings/SubscribersSection.svelte';
  import SubscriptionsSection from '$lib/artifacts/settings/SubscriptionsSection.svelte';
  import { useArtifactSettings } from '$lib/artifacts/settings/context.svelte';
  import Section from '$lib/board/settings/Section.svelte';
  import DictionarySubscriptions from '$lib/dictionary/DictionarySubscriptions.svelte';
  import { firstSettingsSection, settingsSectionsFor } from '$lib/artifacts/store';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';

  const s = useArtifactSettings();
  const section = $derived(page.params.section ?? '');
  // A section this role does not have is "no such section" — an editor asking
  // for /settings/people gets the same answer as a typo.
  const mine = $derived(settingsSectionsFor(s.role).some((x) => x.id === section));
  const first = $derived(firstSettingsSection(s.role));
  // Renamed sections (lib/access): old links still land.
  const MOVED: Record<string, 'subscriptions' | 'dictionaries'> = {
    boards: 'subscriptions',
    bucket: 'subscriptions',
    env: 'dictionaries',
  };
  $effect(() => {
    const to = MOVED[section];
    if (to) void goto(routes.artifactSettings(s.artifact.id, to), { replaceState: true });
  });
</script>

{#key section}
  {#if section in MOVED}
    <!-- redirecting -->
  {:else if !mine}
    <EmptyState
      icon={SearchX}
      title="No such section"
      description="That part of the artifact's settings doesn't exist, or isn't yours to change."
    >
      {#snippet action()}
        {#if first}<Button href={routes.artifactSettings(s.artifact.id, first)}
            >Go to settings</Button
          >{/if}
      {/snippet}
    </EmptyState>
  {:else if section === 'general'}
    <GeneralSection />
  {:else if section === 'people'}
    <PeopleSection />
  {:else if section === 'subscriptions'}
    <SubscriptionsSection />
  {:else if section === 'subscribers'}
    <SubscribersSection />
  {:else if section === 'builds'}
    <BuildsSection />
  {:else if section === 'data'}
    <DataSection />
  {:else if section === 'dictionaries'}
    <Section
      title="Dictionaries"
      description="The dictionaries this artifact's page may use through BackendDriver.dictionary — read, or also write. Anyone looking at the page still reads and changes only what they already can in that dictionary. The artifact's owner adds dictionaries they own; either side can remove one."
    >
      <DictionarySubscriptions
        name="artifact-dictionaries"
        target={{ artifactId: s.artifact.id }}
        manages={s.isOwner}
        frozen={s.artifact.archivedAt != null ? 'Restore the artifact to change this' : null}
      />
    </Section>
  {/if}
{/key}

<!-- /dictionary/[dictionaryId]/settings/[section] — picks the section; the layout provides the dictionary. -->
<script lang="ts">
  import { page } from '$app/state';
  import { SearchX } from 'lucide-svelte';
  import GeneralSection from '$lib/dictionary/settings/GeneralSection.svelte';
  import PeopleSection from '$lib/dictionary/settings/PeopleSection.svelte';
  import SubscribersSection from '$lib/dictionary/settings/SubscribersSection.svelte';
  import { useDictionarySettings } from '$lib/dictionary/settings/context.svelte';
  import { dictionarySettingsFor } from '$lib/dictionary/store';
  import { routes } from '$lib/layout/routes';
  import { Button, EmptyState } from '$lib/ui';
  import Section from '$lib/board/settings/Section.svelte';
  import EntityStorage from '$lib/drive/EntityStorage.svelte';

  const s = useDictionarySettings();
  const section = $derived(page.params.section ?? '');
  const mine = $derived(dictionarySettingsFor(s.role).some((x) => x.id === section));
</script>

{#key section}
  {#if !mine}
    <EmptyState
      icon={SearchX}
      title="No such section"
      description="That part of the dictionary's settings doesn't exist, or isn't yours to change."
    >
      {#snippet action()}<Button href={routes.dictionarySettings(s.dictionary.id, 'subscribers')}
          >Go to settings</Button
        >{/snippet}
    </EmptyState>
  {:else if section === 'general'}
    <GeneralSection />
  {:else if section === 'people'}
    <PeopleSection />
  {:else if section === 'subscribers'}
    <SubscribersSection />
  {:else if section === 'storage'}
    <Section
      title="Storage"
      description="Where this dictionary's entries live: this app's database, or a folder in Google Drive (sealed with your recovery key). Its owner can move it between the two."
    >
      <EntityStorage kind="dictionaries" id={s.dictionary.id} canMove={s.isOwner} />
    </Section>
  {/if}
{/key}

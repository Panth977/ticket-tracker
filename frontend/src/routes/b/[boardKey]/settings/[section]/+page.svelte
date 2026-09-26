<!-- /b/[boardKey]/settings/[section] — picks the section; the layout provides the board. -->
<script lang="ts">
  import { page } from '$app/state';
  import { SearchX } from 'lucide-svelte';
  import { BOARD_SETTINGS_SECTIONS, routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import PeopleAndRoles from '$lib/board/PeopleAndRoles.svelte';
  import AnalyticsSection from '$lib/board/settings/AnalyticsSection.svelte';
  import DangerSection from '$lib/board/settings/DangerSection.svelte';
  import FieldsSection from '$lib/board/settings/FieldsSection.svelte';
  import GeneralSection from '$lib/board/settings/GeneralSection.svelte';
  import GrantsSection from '$lib/board/settings/GrantsSection.svelte';
  import IntakeSection from '$lib/board/settings/IntakeSection.svelte';
  import IntegrationsSection from '$lib/board/settings/IntegrationsSection.svelte';
  import OptionsSection from '$lib/board/settings/OptionsSection.svelte';
  import Section from '$lib/board/settings/Section.svelte';
  import StagesSection from '$lib/board/settings/StagesSection.svelte';
  import TemplatesSection from '$lib/board/settings/TemplatesSection.svelte';
  import { useSettings } from '$lib/board/settings/draft.svelte';

  const s = useSettings();
  const section = $derived(page.params.section ?? 'general');
  const known = $derived(BOARD_SETTINGS_SECTIONS.some((x) => x.id === section));
</script>

{#key section}
  {#if section === 'general'}
    <GeneralSection />
  {:else if section === 'stages'}
    <StagesSection />
  {:else if section === 'priorities'}
    <OptionsSection kind="priorities" />
  {:else if section === 'tags'}
    <OptionsSection kind="tags" />
  {:else if section === 'fields'}
    <FieldsSection />
  {:else if section === 'templates'}
    <TemplatesSection />
  {:else if section === 'people'}
    <Section
      title="People & roles"
      description="Everyone on this board and what they may do. The only way onto a board is an invite from here."
    >
      <PeopleAndRoles boardId={s.board.id} />
    </Section>
  {:else if section === 'grants'}
    <GrantsSection />
  {:else if section === 'intake'}
    <IntakeSection />
  {:else if section === 'integrations'}
    <IntegrationsSection />
  {:else if section === 'analytics'}
    <AnalyticsSection />
  {:else if section === 'danger'}
    <DangerSection />
  {:else if !known}
    <EmptyState
      icon={SearchX}
      title="No such section"
      description="That part of the board's settings doesn't exist."
    >
      {#snippet action()}<Button href={routes.boardSettings(s.board.key, 'general')}
          >Go to General</Button
        >{/snippet}
    </EmptyState>
  {/if}
{/key}

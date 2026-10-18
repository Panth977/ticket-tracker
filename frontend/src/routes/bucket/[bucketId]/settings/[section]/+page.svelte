<!-- /bucket/[bucketId]/settings/[section] — picks the section; the layout provides the bucket. -->
<script lang="ts">
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { SearchX } from 'lucide-svelte';
  import GeneralSection from '$lib/bucket/settings/GeneralSection.svelte';
  import PeopleSection from '$lib/bucket/settings/PeopleSection.svelte';
  import SubscribersSection from '$lib/bucket/settings/SubscribersSection.svelte';
  import Section from '$lib/board/settings/Section.svelte';
  import StorageMove from '$lib/drive/StorageMove.svelte';
  import { useBucketSettings } from '$lib/bucket/settings/context.svelte';
  import { bucketSettingsFor } from '$lib/bucket/store';
  import { routes } from '$lib/layout/routes';
  import { Button, EmptyState } from '$lib/ui';

  const s = useBucketSettings();
  const section = $derived(page.params.section ?? '');
  const mine = $derived(bucketSettingsFor(s.role).some((x) => x.id === section));
  // Renamed (lib/access): old links still land.
  const MOVED: Record<string, 'subscribers'> = { access: 'subscribers' };
  $effect(() => {
    const to = MOVED[section];
    if (to) void goto(routes.bucketSettings(s.bucket.id, to), { replaceState: true });
  });
</script>

{#key section}
  {#if section in MOVED}
    <!-- redirecting -->
  {:else if !mine}
    <EmptyState
      icon={SearchX}
      title="No such section"
      description="That part of the bucket's settings doesn't exist, or isn't yours to change."
    >
      {#snippet action()}<Button href={routes.bucketSettings(s.bucket.id, 'subscribers')}
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
      description="Where this bucket's files live — managed by this app, or a folder in your Google Drive — and moving them from one to the other."
    >
      <StorageMove bucketId={s.bucket.id} />
    </Section>
  {/if}
{/key}

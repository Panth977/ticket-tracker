<!--
  /account/{section} — picks the section component. Notifications has its
  own route (/account/notifications) and never reaches here.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { SearchX } from 'lucide-svelte';
  import ChannelsSection from '$lib/account/sections/ChannelsSection.svelte';
  import ConnectedAppsSection from '$lib/account/sections/ConnectedAppsSection.svelte';
  import DataSection from '$lib/account/sections/DataSection.svelte';
  import ProfileSection from '$lib/account/sections/ProfileSection.svelte';
  import SecuritySection from '$lib/account/sections/SecuritySection.svelte';
  import TokensSection from '$lib/account/sections/TokensSection.svelte';
  import UsageSection from '$lib/account/sections/UsageSection.svelte';
  import UsersSection from '$lib/account/sections/UsersSection.svelte';
  import { ACCOUNT_SECTIONS, routes } from '$lib/layout/routes';
  import { Button, EmptyState } from '$lib/ui';

  const section = $derived(page.params.section ?? 'profile');
  const label = $derived(ACCOUNT_SECTIONS.find((s) => s.id === section)?.label);
</script>

<svelte:head><title>{label ?? 'Account'} · TaskManager</title></svelte:head>

{#if section === 'profile'}
  <ProfileSection />
{:else if section === 'channels'}
  <ChannelsSection />
{:else if section === 'security'}
  <SecuritySection />
{:else if section === 'connected-apps'}
  <ConnectedAppsSection />
{:else if section === 'tokens'}
  <TokensSection />
{:else if section === 'data'}
  <DataSection />
{:else if section === 'users'}
  <!-- §X — the admin's module: who may use this app at all. -->
  <UsersSection />
{:else if section === 'usage'}
  <!-- §X — the admin's other module: what this project costs. -->
  <UsageSection />
{:else}
  <EmptyState
    icon={SearchX}
    title="No such section"
    description="That part of your account doesn’t exist."
  >
    {#snippet action()}<Button href={routes.account('profile')}>Go to Profile</Button>{/snippet}
  </EmptyState>
{/if}

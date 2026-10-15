<!--
  `/`, `/x` and `/bucket` (agents.html §AC): there are no lists of everything
  any more — each thing lives under its owner — so these land on MY page,
  /{my handle}, which lists what I own (and my invitations).
-->
<script lang="ts">
  // goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { Button, EmptyState, Skeleton } from '$lib/ui';

  const handle = $derived(auth.profile?.handle ?? null);
  $effect(() => {
    if (handle) void goto(routes.owner(handle), { replaceState: true });
  });
  // A new account gets its handle from a trigger a moment after sign-up: wait before asking.
  let waited = $state(false);
  $effect(() => {
    const t = setTimeout(() => (waited = true), 6000);
    return () => clearTimeout(t);
  });
</script>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8">
  {#if waited && auth.profileStatus === 'ready' && !handle}
    <EmptyState
      title="Pick your handle"
      description="Your boards, artifacts and buckets live at your own address, /your-handle. Choose one in your profile."
    >
      {#snippet action()}<Button variant="primary" href={routes.account('profile')}>Profile</Button
        >{/snippet}
    </EmptyState>
  {:else}
    <Skeleton width="40%" height="2rem" />
  {/if}
</div>

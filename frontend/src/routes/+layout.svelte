<!--
  Root layout: boots auth, runs the route guard, applies the theme, installs
  the keyboard service, and draws the Shell for screens that have one
  (lib/layout/routes.ts › hasShell). Toasts are global.

  Also: the outbox follows the signed-in user (their unsent changes load and
  resend), and the thin top progress bar covers first load and navigation —
  never a centred spinner on an empty page (agents.html § K).

  § T (local first): when the device remembers who was signed in, auth.start()
  has already read that session synchronously and opened the listeners the
  pointer names, so the gate below falls straight through to the Shell on the
  first frame. The skeleton is what a FIRST visit sees — not a reload.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes or passed in by callers; the SPA has no
  // base path, so resolve() would be the identity.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import '../app.css';
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { outbox } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { guardPending, guardRedirect } from '$lib/firebase/guard';
  import { shortcuts } from '$lib/keyboard/shortcuts';
  import Shell from '$lib/layout/Shell.svelte';
  import { hasShell } from '$lib/layout/routes';
  import Toaster from '$lib/ui/Toaster.svelte';
  import TopProgress from '$lib/ui/TopProgress.svelte';
  import { applyTheme } from '$lib/ui/theme';
  import Skeleton from '$lib/ui/Skeleton.svelte';

  let { children }: { children: Snippet } = $props();

  auth.start();

  const guardState = $derived({
    status: auth.status,
    profile: auth.profileStatus,
    remembered: auth.fromMemory,
    // §X — the allow list, mirrored on the profile: `false` is the only
    // refusal, and it sends them to the one screen they may see.
    allowed: auth.profile ? (auth.profile.allowed ?? null) : null,
  });
  const pending = $derived(guardPending(guardState, page.url));
  const shell = $derived(auth.presumedSignedIn && hasShell(page.url.pathname));
  // §T — a boot painted from memory is live but not yet confirmed. The top bar
  // (§K) is the ONE signal that the refresh is still in flight: no spinner over
  // content that is already on screen, and nothing moves when the server lands.
  const refreshing = $derived(pending || auth.status === 'loading');

  $effect(() => {
    const to = guardRedirect(guardState, page.url);
    if (to) void goto(to, { replaceState: true });
  });

  // The profile's theme wins once it is known; until then app.html applied the saved one.
  $effect(() => {
    if (auth.profile) applyTheme(auth.profile.theme);
  });

  $effect(() => shortcuts.install(window));

  // Each account has its own outbox (persisted entries are keyed by uid).
  $effect(() => {
    if (auth.status === 'loading') return;
    void outbox.setUser(auth.uid);
  });
</script>

<TopProgress active={refreshing} />

{#if pending}
  <!-- A FIRST visit: the shell's outline while auth settles (the top bar shows
       progress). A reload with a remembered session never reaches this (§T). -->
  <div class="flex min-h-dvh bg-bg" data-splash aria-busy="true" aria-label="Loading">
    <div
      class="hidden w-60 shrink-0 flex-col gap-3 border-r border-line bg-surface px-4 py-4 md:flex"
    >
      <Skeleton width="70%" height="1.5rem" class="rounded-md" />
      <Skeleton width="85%" /><Skeleton width="60%" /><Skeleton width="75%" />
    </div>
    <div class="flex flex-1 flex-col gap-3 p-6">
      <Skeleton width="14rem" height="1.25rem" /><Skeleton width="60%" />
    </div>
  </div>
{:else if shell}
  <Shell>{@render children()}</Shell>
{:else}
  {@render children()}
{/if}

<Toaster />

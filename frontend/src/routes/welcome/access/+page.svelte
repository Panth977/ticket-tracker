<!--
  "Ask for access" (agents.html §X) — the whole app, for an account that is
  signed in and not on the allow list.

  Their address, one line saying what this is, and Sign out. No sidebar, no
  boards, no menu, nothing to press that would only be refused: the guard
  (lib/firebase/guard.ts) sends them here from anywhere, and the server refuses
  them anyway — this screen exists so that refusal reads as an answer rather
  than as something broken.

  Nobody lands here by accident: the flag comes from their own profile
  document, which is the one thing an account that is not allowed may read.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { Lock } from 'lucide-svelte';
  import { ADMIN_EMAIL } from '$lib/account/allow';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { Button } from '$lib/ui';

  const email = $derived(auth.user?.email ?? auth.profile?.email ?? '');
  let signingOut = $state(false);

  async function signOut() {
    signingOut = true;
    try {
      await auth.signOut();
      await goto(routes.login(), { replaceState: true });
    } finally {
      signingOut = false;
    }
  }
</script>

<svelte:head><title>Ask for access · TaskManager</title></svelte:head>

<main class="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
  <div
    class="flex w-full max-w-md flex-col items-center gap-5 rounded-xl border border-line bg-surface p-8 text-center"
    data-testid="ask-for-access"
  >
    <div class="rounded-full bg-surface-2 p-3 text-muted">
      <Lock size={22} aria-hidden="true" />
    </div>
    <div class="flex flex-col gap-2">
      <h1 class="text-xl font-semibold">This TaskManager is private</h1>
      <p class="text-sm text-muted">
        It is one person's tracker, and your account is not on its list. Ask
        <a class="text-accent hover:underline" href="mailto:{ADMIN_EMAIL}">{ADMIN_EMAIL}</a> for access
        — they can add you by the address you signed in with.
      </p>
    </div>
    {#if email}
      <p
        class="w-full truncate rounded-md bg-surface-2 px-3 py-2 text-sm"
        data-testid="ask-for-access-email"
      >
        Signed in as {email}
      </p>
    {/if}
    <Button variant="secondary" loading={signingOut} onclick={signOut}>Sign out</Button>
  </div>
</main>

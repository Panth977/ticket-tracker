<!--
  Sign in (app.json › Sign in). No gate: anyone may sign up — Google,
  Microsoft, or a sign-in link by email. The root layout's guard sends a
  signed-in person on to ?next (or /welcome after sign-up); this page only
  has to sign them in. Opening an emailed link lands here and finishes it.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { Mail, MailCheck } from 'lucide-svelte';
  import { safeNext } from '$lib/firebase/guard';
  import { auth } from '$lib/firebase/auth.svelte';
  import { authErrorMessage } from '$lib/account/authErrors';
  import { isEmail } from '$lib/account/inviteDraft';
  import { Button, Input } from '$lib/ui';

  const next = $derived(safeNext(page.url.searchParams.get('next')));

  let email = $state('');
  let error = $state<string | null>(null);
  let busy = $state<'google' | 'microsoft' | 'link' | 'complete' | null>(null);
  let sentTo = $state<string | null>(null);
  /** The link was opened on another device: ask for the address again. */
  let needEmail = $state(false);
  let linkMode = $state(false);

  onMount(() => {
    if (auth.isEmailLink()) {
      linkMode = true;
      void complete();
    }
  });

  async function complete(addr?: string) {
    busy = 'complete';
    error = null;
    try {
      const r = await auth.completeEmailLink(window.location.href, addr);
      needEmail = r === 'needEmail';
      // 'ok': the guard notices the signed-in state and moves on to ?next.
    } catch (e) {
      error = authErrorMessage(e);
      linkMode = false;
    } finally {
      busy = null;
    }
  }

  async function provider(kind: 'google' | 'microsoft') {
    busy = kind;
    error = null;
    try {
      await (kind === 'google' ? auth.signInWithGoogle() : auth.signInWithMicrosoft());
    } catch (e) {
      error = authErrorMessage(e);
    } finally {
      busy = null;
    }
  }

  async function sendLink(e: SubmitEvent) {
    e.preventDefault();
    const addr = email.trim();
    if (!isEmail(addr)) {
      error = 'Enter your email address.';
      return;
    }
    busy = 'link';
    error = null;
    try {
      await auth.sendEmailLink(addr, next);
      sentTo = addr;
    } catch (err) {
      error = authErrorMessage(err);
    } finally {
      busy = null;
    }
  }

  function submitNeedEmail(e: SubmitEvent) {
    e.preventDefault();
    if (!isEmail(email.trim())) {
      error = 'Enter the address the link was sent to.';
      return;
    }
    void complete(email.trim());
  }
</script>

<svelte:head><title>Sign in · TaskManager</title></svelte:head>

<main class="grid min-h-dvh place-items-center bg-bg px-4 py-10">
  <div class="w-full max-w-sm">
    <div class="mb-8 flex flex-col items-center gap-3 text-center">
      <span
        class="grid size-11 place-items-center rounded-xl bg-accent text-lg font-bold text-accent-fg"
        aria-hidden="true">T</span
      >
      <h1 class="text-xl font-semibold">Sign in to TaskManager</h1>
      <p class="text-sm text-muted">New here? Signing in creates your account.</p>
    </div>

    <div class="rounded-xl border border-line bg-surface p-6 shadow-pop">
      {#if linkMode && !needEmail}
        <div class="flex flex-col items-center gap-3 py-4 text-center" aria-live="polite">
          <span
            class="size-6 animate-spin rounded-full border-2 border-line-strong border-t-accent"
            aria-hidden="true"
          ></span>
          <p class="text-sm text-muted">Signing you in…</p>
        </div>
      {:else if needEmail}
        <form class="flex flex-col gap-4" onsubmit={submitNeedEmail}>
          <p class="text-sm">
            You opened the link on a different device. Confirm the address it was sent to.
          </p>
          <Input label="Email" type="email" autocomplete="email" bind:value={email} required />
          <Button type="submit" variant="primary" block loading={busy === 'complete'}
            >Finish signing in</Button
          >
        </form>
      {:else if sentTo}
        <div class="flex flex-col items-center gap-3 py-2 text-center" aria-live="polite">
          <span
            class="grid size-10 place-items-center rounded-full bg-success-soft text-success"
            aria-hidden="true"
          >
            <MailCheck size={20} />
          </span>
          <p class="text-sm">
            We sent a sign-in link to <span class="font-medium">{sentTo}</span>. Open it on this
            device to continue.
          </p>
          <Button variant="link" onclick={() => (sentTo = null)}>Use a different address</Button>
        </div>
      {:else}
        <div class="flex flex-col gap-2">
          <Button
            block
            size="lg"
            loading={busy === 'google'}
            disabled={busy !== null}
            onclick={() => provider('google')}
          >
            <svg viewBox="0 0 24 24" class="size-4" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.8Z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24Z"
              />
              <path
                fill="#FBBC05"
                d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1Z"
              />
              <path
                fill="#EA4335"
                d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9Z"
              />
            </svg>
            Continue with Google
          </Button>
          <Button
            block
            size="lg"
            loading={busy === 'microsoft'}
            disabled={busy !== null}
            onclick={() => provider('microsoft')}
          >
            <svg viewBox="0 0 24 24" class="size-4" aria-hidden="true">
              <path fill="#F25022" d="M1 1h10.5v10.5H1z" /><path
                fill="#7FBA00"
                d="M12.5 1H23v10.5H12.5z"
              />
              <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" /><path
                fill="#FFB900"
                d="M12.5 12.5H23V23H12.5z"
              />
            </svg>
            Continue with Microsoft
          </Button>
        </div>

        <div class="my-5 flex items-center gap-3 text-xs text-subtle" aria-hidden="true">
          <span class="h-px flex-1 bg-line"></span>or<span class="h-px flex-1 bg-line"></span>
        </div>

        <form class="flex flex-col gap-3" onsubmit={sendLink} novalidate>
          <Input
            label="Email"
            type="email"
            autocomplete="email"
            placeholder="you@company.com"
            bind:value={email}
          />
          <Button
            type="submit"
            block
            icon={Mail}
            loading={busy === 'link'}
            disabled={busy !== null}
          >
            Email me a sign-in link
          </Button>
        </form>
      {/if}

      {#if error}
        <p class="mt-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      {/if}
    </div>

    <p class="mt-6 text-center text-xs text-subtle">
      No password needed. You can add one later in Account › Security.
    </p>
  </div>
</main>

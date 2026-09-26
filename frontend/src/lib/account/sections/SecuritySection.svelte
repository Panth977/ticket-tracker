<!--
  Account › Security: how you sign in, an optional password (set later —
  sign-up never needs one), sign out here, and sign out everywhere.
-->
<script lang="ts">
  // goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { updatePassword } from 'firebase/auth';
  import { KeyRound, LogOut, Mail, ShieldCheck } from 'lucide-svelte';
  import { command, isAppError } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { Badge, Button, Dialog, Input, toast } from '$lib/ui';
  import { authErrorMessage } from '../authErrors';
  import Panel from '../Panel.svelte';
  import { currentUser, providerIds, reauthenticate, reauthMethod } from '../reauth';
  import SectionHeader from '../SectionHeader.svelte';
  import { dateTime } from '../format';

  const PROVIDER_LABELS: Record<string, string> = {
    'google.com': 'Google',
    'microsoft.com': 'Microsoft',
    password: 'Password',
    emailLink: 'Email link',
  };

  // Re-read on auth changes (providers change after setting a password).
  let version = $state(0);
  const user = $derived.by(() => {
    void version;
    void auth.user;
    return currentUser();
  });
  const providers = $derived(user ? providerIds(user) : []);
  const hasPassword = $derived(providers.includes('password'));
  const lastSignIn = $derived(
    user?.metadata.lastSignInTime ? Date.parse(user.metadata.lastSignInTime) : null,
  );

  // Password
  let pwOpen = $state(false);
  let pw = $state('');
  let pw2 = $state('');
  let currentPw = $state('');
  let pwBusy = $state(false);
  let pwError = $state<string | null>(null);

  async function setPassword(e: SubmitEvent) {
    e.preventDefault();
    if (pw.length < 8) return void (pwError = 'Use at least 8 characters.');
    if (pw !== pw2) return void (pwError = 'The two passwords differ.');
    const u = currentUser();
    if (!u) return;
    pwBusy = true;
    pwError = null;
    try {
      try {
        await updatePassword(u, pw);
      } catch (err) {
        if ((err as { code?: string }).code !== 'auth/requires-recent-login') throw err;
        const ok = await reauthenticate(currentPw || undefined);
        if (!ok) {
          pwError =
            reauthMethod(providers) === 'password'
              ? 'Enter your current password to confirm it’s you.'
              : 'For your security, sign in again with an email link first, then set the password.';
          return;
        }
        await updatePassword(u, pw);
      }
      await u.reload();
      version++;
      pwOpen = false;
      toast.success(
        hasPassword ? 'Password changed' : 'Password set — you can now sign in with it',
      );
    } catch (err) {
      pwError = authErrorMessage(err);
    } finally {
      pwBusy = false;
    }
  }

  // Sign out
  let outBusy = $state<'here' | 'all' | null>(null);
  let confirmAll = $state(false);
  async function signOutHere() {
    outBusy = 'here';
    await auth.signOut();
    await goto(routes.login(), { replaceState: true });
  }
  async function signOutEverywhere() {
    outBusy = 'all';
    try {
      // Revokes every refresh token for this account.
      await command('sessionRevokeAll', {});
    } catch (err) {
      outBusy = null;
      confirmAll = false;
      if (isAppError(err) && err.code === 'not_found')
        toast.error(
          'Signing out other devices isn’t available yet',
          'You were not signed out anywhere.',
        );
      else toast.error('Could not sign out everywhere', isAppError(err) ? err.message : undefined);
      return;
    }
    await auth.signOut();
    await goto(routes.login(), { replaceState: true });
  }
</script>

<SectionHeader title="Security" description="How you sign in, and where you’re signed in." />

<div class="flex flex-col gap-6">
  <Panel title="Sign-in methods">
    <ul class="flex flex-col gap-2">
      {#each providers.length ? providers : ['emailLink'] as p (p)}
        <li class="flex items-center gap-2 text-sm">
          {#if p === 'password'}<KeyRound
              size={16}
              class="text-muted"
              aria-hidden="true"
            />{:else if p === 'emailLink'}<Mail
              size={16}
              class="text-muted"
              aria-hidden="true"
            />{:else}<ShieldCheck size={16} class="text-muted" aria-hidden="true" />{/if}
          {PROVIDER_LABELS[p] ?? p}
          {#if p !== 'password' && p !== 'emailLink'}<Badge>{auth.user?.email}</Badge>{/if}
        </li>
      {/each}
      <li class="flex items-center gap-2 text-sm text-muted">
        <Mail size={16} aria-hidden="true" /> A sign-in link to {auth.user?.email} always works.
      </li>
    </ul>
    {#if lastSignIn}<p class="text-xs text-subtle">
        Last signed in {dateTime(lastSignIn, auth.profile?.timezone)}
      </p>{/if}
  </Panel>

  <Panel
    title="Password"
    description={hasPassword
      ? 'You can sign in with your email and password.'
      : 'Optional — add one to sign in without a link.'}
  >
    {#snippet actions()}
      <Button
        onclick={() => {
          pw = pw2 = currentPw = '';
          pwError = null;
          pwOpen = true;
        }}>{hasPassword ? 'Change password' : 'Set a password'}</Button
      >
    {/snippet}
    <p class="text-xs text-subtle">Passkeys are coming later.</p>
  </Panel>

  <Panel
    title="Sessions"
    description="Signing out everywhere ends every session — phones, other browsers, this one."
  >
    <div class="flex flex-wrap gap-2">
      <Button icon={LogOut} loading={outBusy === 'here'} onclick={signOutHere}
        >Sign out on this device</Button
      >
      <Button variant="danger" onclick={() => (confirmAll = true)}>Sign out everywhere</Button>
    </div>
  </Panel>
</div>

<Dialog bind:open={pwOpen} title={hasPassword ? 'Change password' : 'Set a password'} size="sm">
  <form id="pw-form" class="flex flex-col gap-3" onsubmit={setPassword} novalidate>
    {#if hasPassword}
      <Input
        label="Current password"
        type="password"
        autocomplete="current-password"
        bind:value={currentPw}
      />
    {/if}
    <Input
      label="New password"
      type="password"
      autocomplete="new-password"
      hint="At least 8 characters."
      bind:value={pw}
    />
    <Input label="Repeat it" type="password" autocomplete="new-password" bind:value={pw2} />
    {#if pwError}<p class="text-sm text-danger" role="alert">{pwError}</p>{/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (pwOpen = false)}>Cancel</Button>
    <Button type="submit" form="pw-form" variant="primary" loading={pwBusy}>Save password</Button>
  {/snippet}
</Dialog>

<Dialog bind:open={confirmAll} title="Sign out everywhere?" size="sm">
  <p class="text-sm">
    Every device signed in to your account — including this one — will need to sign in again.
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (confirmAll = false)}>Cancel</Button>
    <Button variant="danger" loading={outBusy === 'all'} onclick={signOutEverywhere}
      >Sign out everywhere</Button
    >
  {/snippet}
</Dialog>

<!--
  Accept an invite (app.json › Accept an invite) — where the emailed link
  lands: /invite/{inviteId}.{token}. The invite names the board, so it is
  readable before the board is — but only by the INVITED ADDRESS (rules:
  invite.email == my verified email). Signed in as someone else, the doc is
  unreadable and inviteAccept answers 403: 'this invite is for a***@acme.com',
  switch account. A forwarded link is the most common way access goes to
  the wrong person.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { CircleAlert, Mail, UserRoundX } from 'lucide-svelte';
  import { paths, type Invite } from '@tm/shared';
  import { command, isAppError } from '$lib/api';
  import { docStore } from '$lib/stores';
  import { ROLE_LABELS } from '$lib/account/inviteDraft';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { maskEmail } from '$lib/people/format';
  import { Badge, Button } from '$lib/ui';

  const inviteId = $derived(page.params.id ?? '');
  const token = $derived(page.params.token ?? '');
  const inviteQ = $derived(docStore<Invite>(inviteId ? paths.invite(inviteId) : null));
  const invite = $derived($inviteQ.data);
  const myEmail = $derived(auth.user?.email ?? '');

  let busy = $state(false);
  /** What inviteAccept said, when it refused. */
  let refusal = $state<{
    kind: 'wrongAddress' | 'gone' | 'notFound' | 'other';
    message: string;
    email?: string;
  } | null>(null);

  type View =
    'loading' | 'unverified' | 'unreadable' | 'pending' | 'accepted' | 'closed' | 'expired';
  const view: View = $derived.by(() => {
    if (auth.user && !auth.user.emailVerified) return 'unverified';
    if ($inviteQ.loading) return 'loading';
    if (!invite) return 'unreadable';
    if (invite.status === 'accepted') return 'accepted';
    if (invite.status !== 'pending') return 'closed';
    if (invite.expiresAt <= Date.now()) return 'expired';
    return 'pending';
  });

  async function join() {
    busy = true;
    refusal = null;
    try {
      const r = await command('inviteAccept', { inviteId, token, accept: true }, { toast: false });
      // A brand-new account still has Welcome to do; the guard sends it there.
      // An invite to an ARTIFACT (artifacts.html §B) names no board.
      await goto(r.artifactId ? routes.artifact(r.artifactId) : routes.board(r.boardKey), {
        replaceState: true,
      });
    } catch (e) {
      if (!isAppError(e)) throw e;
      // inviteAccept answers 403 { invitedEmail: 'a***@acme.com' } (masked).
      const details = (e.details ?? {}) as { invitedEmail?: string; email?: string };
      if (e.code === 'forbidden')
        refusal = {
          kind: 'wrongAddress',
          message: e.message,
          email:
            details.invitedEmail ?? details.email ?? (invite ? maskEmail(invite.email) : undefined),
        };
      else if (e.code === 'gone')
        refusal = {
          kind: 'gone',
          message: 'This invite is no longer valid — it was used, revoked or has expired.',
        };
      else if (e.code === 'not_found')
        refusal = {
          kind: 'notFound',
          message: 'This invite link is not valid. Ask for a new one.',
        };
      else refusal = { kind: 'other', message: e.message || 'Could not join — try again.' };
    } finally {
      busy = false;
    }
  }

  async function switchAccount() {
    const here = page.url.pathname;
    await auth.signOut();
    await goto(routes.login(here), { replaceState: true });
  }
</script>

<svelte:head><title>Invitation · TaskManager</title></svelte:head>

<main class="grid min-h-dvh place-items-center bg-bg px-4 py-10">
  <div class="w-full max-w-md rounded-xl border border-line bg-surface p-6 shadow-pop">
    {#if view === 'loading'}
      <div class="flex items-center gap-3 py-6 text-sm text-muted" aria-busy="true">
        <span class="size-5 animate-spin rounded-full border-2 border-line-strong border-t-accent"
        ></span>
        Opening your invitation…
      </div>
    {:else if view === 'unverified'}
      <div class="flex flex-col gap-3">
        <h1 class="text-lg font-semibold">Verify your email first</h1>
        <p class="text-sm text-muted">
          Invites go to an address, so we need to know <span class="font-medium text-text"
            >{myEmail}</span
          > is yours. Sign in with a link sent to it instead.
        </p>
        <Button variant="primary" onclick={switchAccount}>Sign in with an email link</Button>
      </div>
    {:else if view === 'pending' && invite && refusal?.kind !== 'wrongAddress'}
      <div class="flex flex-col gap-5">
        <span
          class="grid size-10 place-items-center rounded-full bg-accent-soft text-accent"
          aria-hidden="true"
        >
          <Mail size={20} />
        </span>
        <div class="flex flex-col gap-1">
          <h1 class="text-lg font-semibold">
            {invite.invitedByName || 'Someone'} invited you to {invite.boardName}
          </h1>
          <p class="text-sm text-muted">
            as <Badge tone="accent">{ROLE_LABELS[invite.role]}</Badge>
            {#if !invite.artifactId}on <span class="font-mono">{invite.boardKey}</span>{/if}
          </p>
        </div>
        {#if invite.message}
          <blockquote class="border-l-2 border-line-strong pl-3 text-sm text-muted">
            {invite.message}
          </blockquote>
        {/if}
        {#if refusal}
          <p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
            {refusal.message}
          </p>
        {/if}
        {#if !auth.profile}
          <p class="text-xs text-subtle">Setting up your account…</p>
        {/if}
        <div class="flex justify-end gap-2">
          <Button variant="ghost" href={routes.home()}>Not now</Button>
          <Button variant="primary" loading={busy} disabled={!auth.profile} onclick={join}
            >Join</Button
          >
        </div>
      </div>
    {:else if view === 'accepted'}
      <div class="flex flex-col gap-3">
        <h1 class="text-lg font-semibold">You’re already on {invite?.boardName}</h1>
        {#if invite?.artifactId}
          <Button variant="primary" href={routes.artifact(invite.artifactId)}>Open it</Button>
        {:else}
          <Button variant="primary" href={routes.board(invite?.boardKey ?? '')}
            >Open the board</Button
          >
        {/if}
      </div>
    {:else if view === 'closed' || view === 'expired'}
      <div class="flex flex-col gap-3">
        <span class="text-warning"><CircleAlert size={22} aria-hidden="true" /></span>
        <h1 class="text-lg font-semibold">This invite is no longer valid</h1>
        <p class="text-sm text-muted">
          {view === 'expired'
            ? 'It expired — invites last 14 days.'
            : invite?.status === 'revoked'
              ? 'It was withdrawn by the board.'
              : 'It was declined.'}
          Ask {invite?.invitedByName || 'the person who invited you'} to send a new one.
        </p>
        <Button href={routes.home()}>Go to your boards</Button>
      </div>
    {:else}
      <!-- unreadable: not for this address (or no such invite) -->
      <div class="flex flex-col gap-4">
        <span
          class="grid size-10 place-items-center rounded-full bg-warning-soft text-warning"
          aria-hidden="true"
        >
          <UserRoundX size={20} />
        </span>
        <div class="flex flex-col gap-1">
          <h1 class="text-lg font-semibold">This invite is for a different address</h1>
          <p class="text-sm text-muted">
            {#if refusal?.email}
              This invite is for <span class="font-medium text-text">{refusal.email}</span>, but
              you’re signed in as
              <span class="font-medium text-text">{myEmail}</span>.
            {:else}
              You’re signed in as <span class="font-medium text-text">{myEmail}</span>, and this
              invite was sent to another address.
            {/if}
            Switch to the invited account to join.
          </p>
        </div>
        {#if refusal && refusal.kind !== 'wrongAddress'}
          <p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
            {refusal.message}
          </p>
        {/if}
        <div class="flex flex-wrap justify-end gap-2">
          {#if !refusal}
            <Button variant="ghost" loading={busy} onclick={join}>Try anyway</Button>
          {/if}
          <Button variant="primary" onclick={switchAccount}>Switch account</Button>
        </div>
      </div>
    {/if}
  </div>
</main>

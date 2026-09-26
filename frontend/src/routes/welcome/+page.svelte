<!--
  Welcome (app.json › Welcome) — right after sign-up.
    1. About you: picture (Google's is already copied in by onUserCreated, or
       upload one), display name, time zone.
    2. Invites waiting for your address come FIRST — joining beats starting
       from nothing; otherwise 'Create your first board'.
  Leaving by any door calls auth.finishWelcome() so the guard lets you go.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { ArrowRight, Plus } from 'lucide-svelte';
  import { command } from '$lib/api';
  import AvatarEditor from '$lib/account/AvatarEditor.svelte';
  import InviteCard from '$lib/account/InviteCard.svelte';
  import { browserTimeZone, timeZones, zoneLabel } from '$lib/account/timezones';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { myInvites } from '$lib/stores';
  import { Button, Input, Select, Skeleton } from '$lib/ui';

  let step = $state<1 | 2>(1);
  let name = $state('');
  let timezone = $state(browserTimeZone());
  let nameError = $state<string | null>(null);
  let saving = $state(false);
  let joined = $state<{ boardId: string; boardKey: string }[]>([]);
  let seeded = false;

  // Prefill once the profile exists (onUserCreated writes it moments after sign-up).
  $effect(() => {
    const p = auth.profile;
    if (!p || seeded) return;
    seeded = true;
    name = p.name || auth.user?.displayName || '';
    // The server keeps the client's first zone; a fresh browser zone is the better guess.
    timezone = p.timezone && p.timezone !== 'UTC' ? p.timezone : browserTimeZone();
  });

  const zones = $derived(timeZones(timezone).map((z) => ({ value: z, label: zoneLabel(z) })));
  const invitesQ = $derived(myInvites(auth.user?.emailVerified ? auth.user.email : null));
  const invites = $derived($invitesQ.data.filter((i) => i.expiresAt > Date.now()));

  async function saveProfile(e: SubmitEvent) {
    e.preventDefault();
    const n = name.trim();
    nameError = n
      ? n.length > 60
        ? 'At most 60 characters.'
        : null
      : 'Tell people what to call you.';
    if (nameError) return;
    saving = true;
    try {
      await command(
        'profileUpdate',
        { name: n, timezone, locale: navigator.language || 'en' },
        { toast: 'Could not save your profile' },
      );
      step = 2;
    } catch {
      /* toasted */
    } finally {
      saving = false;
    }
  }

  async function leave(to: string) {
    auth.finishWelcome();
    await goto(to, { replaceState: true });
  }
</script>

<svelte:head><title>Welcome · TaskManager</title></svelte:head>

<main class="min-h-dvh bg-bg px-4 py-10 sm:py-16">
  <div class="mx-auto flex w-full max-w-xl flex-col gap-6">
    <header class="flex flex-col gap-1">
      <p class="text-xs font-medium tracking-wide text-subtle uppercase">Step {step} of 2</p>
      <h1 class="text-2xl font-semibold">
        {step === 1
          ? 'Welcome to TaskManager'
          : invites.length
            ? 'You’ve been invited'
            : 'Start your first board'}
      </h1>
      <p class="text-sm text-muted">
        {step === 1
          ? 'How you appear to the people you work with.'
          : invites.length
            ? 'Join the boards waiting for you — or start your own.'
            : 'A board holds your tickets, stages and people. You’ll be its admin.'}
      </p>
    </header>

    {#if !auth.profile}
      <div
        class="flex flex-col gap-4 rounded-xl border border-line bg-surface p-6"
        aria-busy="true"
      >
        <p class="text-sm text-muted">Setting up your account…</p>
        <Skeleton height="4.5rem" width="4.5rem" class="rounded-full" />
        <Skeleton height="2rem" />
        <Skeleton height="2rem" />
      </div>
    {:else if step === 1}
      <form
        class="flex flex-col gap-5 rounded-xl border border-line bg-surface p-6"
        onsubmit={saveProfile}
        novalidate
      >
        <div class="flex flex-col gap-2">
          <span class="text-sm font-medium">Profile picture</span>
          <AvatarEditor />
        </div>
        <Input
          label="Display name"
          hint="Shown on everything you do. Not unique — your email tells you apart."
          autocomplete="name"
          maxlength={60}
          bind:value={name}
          error={nameError}
        />
        <Select
          label="Time zone"
          hint="Due dates and quiet hours use it."
          options={zones}
          bind:value={timezone}
        />
        <div class="flex justify-end">
          <Button type="submit" variant="primary" loading={saving}>
            Continue <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </div>
      </form>
    {:else}
      {#if $invitesQ.loading}
        <Skeleton height="4rem" />
      {:else if invites.length}
        <section class="flex flex-col gap-2" aria-label="Invitations">
          {#each invites as inv (inv.id)}
            <InviteCard invite={inv} onaccepted={(r) => (joined = [...joined, r])} />
          {/each}
        </section>
      {/if}

      {#if joined.length}
        <div class="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4">
          <p class="flex-1 text-sm">
            You’re on {joined.length === 1 ? joined[0]!.boardKey : `${joined.length} boards`}.
          </p>
          <Button
            variant="primary"
            onclick={() =>
              leave(joined.length === 1 ? routes.board(joined[0]!.boardKey) : routes.home())}
          >
            Open {joined.length === 1 ? 'the board' : 'your boards'}
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </div>
      {/if}

      <div
        class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-line-strong p-5"
      >
        <div>
          <p class="text-sm font-medium">
            {invites.length || joined.length ? 'Or start your own' : 'Create your first board'}
          </p>
          <p class="text-sm text-muted">Pick a template — Kanban, bug tracker, support desk…</p>
        </div>
        <Button
          variant={invites.length || joined.length ? 'secondary' : 'primary'}
          icon={Plus}
          onclick={() => leave(routes.newBoard())}
        >
          Create your first board
        </Button>
      </div>

      <div class="flex justify-between">
        <Button variant="ghost" onclick={() => (step = 1)}>Back</Button>
        <Button variant="link" onclick={() => leave(routes.home())}>Skip for now</Button>
      </div>
    {/if}
  </div>
</main>

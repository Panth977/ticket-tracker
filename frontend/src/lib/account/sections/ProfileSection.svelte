<!--
  Account › Profile: picture (upload, crop), display name, email (your
  sign-in — changing it goes through Firebase's verify-new-email flow; the
  next sign-in copies the verified address to users/ and members/), time
  zone, theme. Everything saves through profileUpdate.
-->
<script lang="ts">
  import { verifyBeforeUpdateEmail } from 'firebase/auth';
  import { Monitor, Moon, Sun } from 'lucide-svelte';
  import { paths, THEMES, type Theme } from '@tm/shared';
  import { command } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { Badge, Button, Dialog, Input, Select, Skeleton, toast } from '$lib/ui';
  import AvatarEditor from '../AvatarEditor.svelte';
  import { authErrorMessage } from '../authErrors';
  import { isEmail } from '../inviteDraft';
  import Panel from '../Panel.svelte';
  import { currentUser } from '../reauth';
  import SectionHeader from '../SectionHeader.svelte';
  import { timeZones, zoneLabel } from '../timezones';

  const profile = $derived(auth.profile);

  let name = $state('');
  let timezone = $state('UTC');
  let seededFor: string | null = null;
  $effect(() => {
    // Seed the form once per profile load (not on every live update, which would eat typing).
    if (profile && seededFor !== profile.id) {
      seededFor = profile.id;
      name = profile.name;
      timezone = profile.timezone;
    }
  });

  const dirty = $derived(
    !!profile && (name.trim() !== profile.name || timezone !== profile.timezone),
  );
  const nameError = $derived(!name.trim() ? 'A display name is required.' : null);
  const zones = $derived(timeZones(timezone).map((z) => ({ value: z, label: zoneLabel(z) })));
  let saving = $state(false);

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!profile || nameError) return;
    saving = true;
    try {
      await command(
        'profileUpdate',
        {
          ...(name.trim() !== profile.name ? { name: name.trim() } : {}),
          ...(timezone !== profile.timezone ? { timezone } : {}),
        },
        { toast: 'Could not save your profile' },
      );
      toast.success('Profile saved');
    } catch {
      /* toasted */
    } finally {
      saving = false;
    }
  }

  const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon } as const;
  async function setTheme(theme: Theme) {
    if (!profile || profile.theme === theme || !auth.uid) return;
    try {
      await command(
        'profileUpdate',
        { theme },
        {
          optimistic: { path: paths.user(auth.uid), patch: { theme } },
          toast: 'Could not change the theme',
        },
      );
    } catch {
      /* rolled back */
    }
  }

  // Email change
  let emailOpen = $state(false);
  let newEmail = $state('');
  let emailBusy = $state(false);
  let emailError = $state<string | null>(null);
  let emailSent = $state<string | null>(null);
  async function changeEmail(e: SubmitEvent) {
    e.preventDefault();
    const addr = newEmail.trim().toLowerCase();
    if (!isEmail(addr)) return void (emailError = 'Enter a valid address.');
    if (addr === auth.user?.email?.toLowerCase())
      return void (emailError = 'That is already your address.');
    const u = currentUser();
    if (!u) return;
    emailBusy = true;
    emailError = null;
    try {
      await verifyBeforeUpdateEmail(u, addr, { url: `${location.origin}/account/profile` });
      emailSent = addr;
    } catch (err) {
      emailError = authErrorMessage(err);
    } finally {
      emailBusy = false;
    }
  }
</script>

<SectionHeader title="Profile" description="How you appear to everyone on your boards." />

{#if !profile}
  <div class="flex flex-col gap-3">
    <Skeleton height="4.5rem" width="4.5rem" class="rounded-full" /><Skeleton height="2rem" />
  </div>
{:else}
  <div class="flex flex-col gap-6">
    <Panel title="Profile picture">
      <AvatarEditor />
    </Panel>

    <Panel>
      <form class="flex flex-col gap-4" onsubmit={save} novalidate>
        <Input
          label="Display name"
          maxlength={60}
          bind:value={name}
          error={nameError}
          autocomplete="name"
        />
        <div class="flex flex-col gap-1">
          <span class="text-sm font-medium">Email</span>
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm">{auth.user?.email ?? profile.email}</span>
            {#if auth.user?.emailVerified}<Badge tone="success">Verified</Badge>{:else}<Badge
                tone="warning">Unverified</Badge
              >{/if}
            <Button
              variant="link"
              size="sm"
              onclick={() => {
                newEmail = '';
                emailError = null;
                emailSent = null;
                emailOpen = true;
              }}>Change</Button
            >
          </div>
          <p class="text-xs text-muted">Your sign-in address, and where email notifications go.</p>
        </div>
        <Select
          label="Time zone"
          hint="Due dates, quiet hours and digests use it."
          options={zones}
          bind:value={timezone}
        />
        <div class="flex justify-end">
          <Button type="submit" variant="primary" loading={saving} disabled={!dirty || !!nameError}
            >Save</Button
          >
        </div>
      </form>
    </Panel>

    <Panel title="Theme">
      <div class="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
        {#each THEMES as t (t)}
          {@const Icon = THEME_ICONS[t]}
          <button
            type="button"
            role="radio"
            aria-checked={profile.theme === t}
            class="flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-sm capitalize transition-colors {profile.theme ===
            t
              ? 'border-accent bg-accent-soft text-text'
              : 'border-line hover:bg-surface-2'}"
            onclick={() => setTheme(t)}
          >
            <Icon size={18} aria-hidden="true" />
            {t}
          </button>
        {/each}
      </div>
    </Panel>
  </div>
{/if}

<Dialog bind:open={emailOpen} title="Change your email" size="sm">
  {#if emailSent}
    <p class="text-sm">
      We sent a link to <span class="font-medium">{emailSent}</span>. Your address changes when you
      open it; sign in again afterwards and your boards will show the new address.
    </p>
  {:else}
    <form id="email-form" class="flex flex-col gap-3" onsubmit={changeEmail} novalidate>
      <p class="text-sm text-muted">
        We’ll send a confirmation link to the new address. Nothing changes until you open it.
      </p>
      <Input
        label="New email"
        type="email"
        autocomplete="email"
        bind:value={newEmail}
        error={emailError}
      />
    </form>
  {/if}
  {#snippet footer()}
    {#if emailSent}
      <Button variant="primary" onclick={() => (emailOpen = false)}>Done</Button>
    {:else}
      <Button variant="ghost" onclick={() => (emailOpen = false)}>Cancel</Button>
      <Button type="submit" form="email-form" variant="primary" loading={emailBusy}
        >Send link</Button
      >
    {/if}
  {/snippet}
</Dialog>

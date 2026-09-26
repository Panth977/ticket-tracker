<!--
  Account › Channels — where notifications can reach you:
    Email     your sign-in address (where mail goes)
    Push      'Enable push on this browser' + every device you enabled
    WhatsApp  link a number with a one-time code (explicit, recorded opt-in —
              Meta requires it before any business-initiated message)
  A channel you haven't set up is greyed out in Notifications.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { BellRing, Mail, MessageCircle, Monitor, Smartphone, Trash2 } from 'lucide-svelte';
  import { paths, type Device } from '@tm/shared';
  import { command, isAppError } from '$lib/api';
  import { WHATSAPP_ENABLED } from '$lib/features';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { queryStore } from '$lib/stores';
  import { Badge, Button, Checkbox, Input, Skeleton, toast } from '$lib/ui';
  import { dateOnly, relativeTime } from '../format';
  import Panel from '../Panel.svelte';
  import { deviceId, push, pushSupported } from '$lib/notifications';
  import { describeAgent, removeDevice } from '../devices';
  import SectionHeader from '../SectionHeader.svelte';
  import { maskNumber, normalizeCode, toE164 } from '../whatsapp';

  const uid = $derived(auth.uid);
  const profile = $derived(auth.profile);
  const devicesQ = $derived(queryStore<Device>(uid ? { path: paths.devices(uid) } : null));
  const devices = $derived([...$devicesQ.data].sort((a, b) => b.lastSeenAt - a.lastSeenAt));

  // ---- push
  let myDevice = $state<string | null>(null);
  let perm = $state<'default' | 'granted' | 'denied' | 'unsupported'>('default');
  let enabling = $state(false);
  onMount(() => {
    myDevice = deviceId();
    push.sync();
    perm = push.permission;
  });
  const thisEnabled = $derived(!!myDevice && devices.some((d) => d.id === myDevice));

  async function enable() {
    if (!uid) return;
    enabling = true;
    try {
      if (!(await push.enable(uid))) throw new Error(push.error ?? 'Permission was not granted');
      toast.success('Push is on for this browser');
    } catch (e) {
      toast.error('Could not enable push', (e as Error).message);
    } finally {
      perm = push.permission;
      enabling = false;
    }
  }
  async function remove(id: string) {
    if (!uid) return;
    try {
      await removeDevice(uid, id);
    } catch {
      toast.error('Could not remove the device');
    }
  }

  // ---- WhatsApp
  let number = $state('');
  let code = $state('');
  let step = $state<'number' | 'code'>('number');
  let sentTo = $state('');
  let waBusy = $state(false);
  let waError = $state<string | null>(null);
  let relinking = $state(false);
  const linked = $derived(!!profile?.whatsapp && !relinking);

  function waMessage(e: unknown, fallback: string): string {
    if (!isAppError(e)) return fallback;
    switch (e.code) {
      case 'rate_limited':
        return 'Too many codes — wait a few minutes and try again.';
      case 'gone':
        return 'That code expired — send a new one.';
      case 'forbidden':
        return 'Too many wrong codes — send a new one.';
      case 'invalid':
        return step === 'code'
          ? 'That code is not right.'
          : e.message || 'That number was refused.';
      default:
        return e.message || fallback;
    }
  }

  async function sendCode(e?: SubmitEvent) {
    e?.preventDefault();
    const n = toE164(number);
    if (!n) return void (waError = 'Enter the number with its country code, e.g. +91 98123 45678.');
    waBusy = true;
    waError = null;
    try {
      await command('whatsappLink', { step: 'send', number: n }, { toast: false });
      sentTo = n;
      code = '';
      step = 'code';
    } catch (err) {
      waError = waMessage(err, 'Could not send the code.');
    } finally {
      waBusy = false;
    }
  }

  async function verify(e: SubmitEvent) {
    e.preventDefault();
    if (code.length !== 6) return void (waError = 'Enter the 6-digit code.');
    waBusy = true;
    waError = null;
    try {
      await command('whatsappLink', { step: 'verify', code }, { toast: false });
      toast.success('WhatsApp linked');
      step = 'number';
      relinking = false;
      number = '';
    } catch (err) {
      waError = waMessage(err, 'Could not verify the code.');
      if (isAppError(err) && (err.code === 'gone' || err.code === 'forbidden')) step = 'number';
    } finally {
      waBusy = false;
    }
  }

  async function setOptIn(on: boolean) {
    if (!uid) return;
    try {
      await command(
        'profileUpdate',
        { whatsappOptIn: on },
        {
          optimistic: { path: paths.user(uid), patch: { 'whatsapp.optIn': on } },
          toast: 'Could not change WhatsApp',
        },
      );
    } catch {
      /* rolled back */
    }
  }
</script>

<SectionHeader
  title="Channels"
  description="Where notifications can reach you. Choose what goes where in Notifications."
/>

<div class="flex flex-col gap-6">
  <Panel title="Email">
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <Mail size={16} class="text-muted" aria-hidden="true" />
      <span>{auth.user?.email ?? profile?.email}</span>
      {#if auth.user?.emailVerified}<Badge tone="success">Verified</Badge>{/if}
      <Button variant="link" size="sm" href={routes.account('profile')}>Change in Profile</Button>
    </div>
    <p class="text-xs text-muted">
      Mail always goes to your sign-in address. Replying to a notification posts a comment.
    </p>
  </Panel>

  <Panel
    title="Push"
    description="Notifications on this computer or phone, even when TaskManager isn’t open."
  >
    {#snippet actions()}
      {#if thisEnabled}
        <Badge tone="success">On for this browser</Badge>
      {:else}
        <Button
          icon={BellRing}
          loading={enabling}
          disabled={perm === 'unsupported' || perm === 'denied'}
          onclick={enable}
        >
          Enable push on this browser
        </Button>
      {/if}
    {/snippet}
    {#if perm === 'denied'}
      <p class="text-sm text-warning">
        Notifications are blocked for this site — allow them in your browser’s settings, then come
        back.
      </p>
    {:else if !pushSupported() && perm === 'unsupported'}
      <p class="text-sm text-muted">This browser can’t receive push notifications.</p>
    {/if}
    {#if $devicesQ.loading}
      <Skeleton lines={2} />
    {:else if devices.length}
      <ul class="divide-y divide-line rounded-lg border border-line">
        {#each devices as d (d.id)}
          <li class="flex items-center gap-3 px-3 py-2">
            {#if d.kind === 'web'}<Monitor
                size={16}
                class="text-muted"
                aria-hidden="true"
              />{:else}<Smartphone size={16} class="text-muted" aria-hidden="true" />{/if}
            <div class="min-w-0 flex-1">
              <p class="flex items-center gap-2 text-sm">
                {d.kind === 'web'
                  ? describeAgent(d.userAgent)
                  : d.kind === 'ios'
                    ? 'iPhone / iPad'
                    : 'Android'}
                {#if d.id === myDevice}<Badge tone="accent">This browser</Badge>{/if}
              </p>
              <p class="text-xs text-subtle">Last seen {relativeTime(d.lastSeenAt)}</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon={Trash2}
              aria-label="Remove {describeAgent(d.userAgent)}"
              onclick={() => remove(d.id)}
            >
              Remove
            </Button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="text-sm text-muted">No devices yet.</p>
    {/if}
  </Panel>

  <Panel title="WhatsApp" description="Get notified on WhatsApp and reply to comment from there.">
    {#if !WHATSAPP_ENABLED}
      <div class="flex items-center gap-3 text-sm text-subtle opacity-60" aria-disabled="true">
        <MessageCircle size={16} aria-hidden="true" />
        <span>WhatsApp isn’t available on this server yet.</span>
      </div>
    {:else if linked && profile?.whatsapp}
      <div class="flex flex-wrap items-center gap-3 text-sm">
        <MessageCircle size={16} class="text-success" aria-hidden="true" />
        <span class="font-medium">{maskNumber(profile.whatsapp.number)}</span>
        <span class="text-xs text-subtle"
          >linked {dateOnly(profile.whatsapp.verifiedAt, profile.timezone)}</span
        >
        <Button variant="link" size="sm" onclick={() => (relinking = true)}>Change number</Button>
      </div>
      <Checkbox
        checked={profile.whatsapp.optIn}
        label="Send me notifications on WhatsApp"
        description="Turning this off keeps your number linked; nothing is sent until you turn it back on."
        onchange={(e) => setOptIn((e.currentTarget as HTMLInputElement).checked)}
      />
    {:else if step === 'number'}
      <form class="flex flex-wrap items-end gap-2" onsubmit={sendCode} novalidate>
        <Input
          class="min-w-56 flex-1"
          label="Your WhatsApp number"
          type="tel"
          autocomplete="tel"
          placeholder="+91 98123 45678"
          bind:value={number}
          error={waError}
        />
        <Button type="submit" loading={waBusy}>Send code</Button>
        {#if relinking}<Button variant="ghost" onclick={() => (relinking = false)}>Cancel</Button
          >{/if}
      </form>
      <p class="text-xs text-muted">
        We’ll send a 6-digit code on WhatsApp. Linking means you agree to receive notifications
        there.
      </p>
    {:else}
      <form class="flex flex-wrap items-end gap-2" onsubmit={verify} novalidate>
        <Input
          class="w-40"
          inputClass="font-mono tracking-widest"
          label="Code sent to {maskNumber(sentTo)}"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength={6}
          value={code}
          oninput={(e) => (code = normalizeCode((e.currentTarget as HTMLInputElement).value))}
          error={waError}
        />
        <Button type="submit" variant="primary" loading={waBusy}>Verify</Button>
        <Button variant="ghost" disabled={waBusy} onclick={() => sendCode()}>Resend</Button>
        <Button variant="link" onclick={() => ((step = 'number'), (waError = null))}
          >Different number</Button
        >
      </form>
      <p class="text-xs text-muted">The code works for 10 minutes.</p>
    {/if}
  </Panel>
</div>

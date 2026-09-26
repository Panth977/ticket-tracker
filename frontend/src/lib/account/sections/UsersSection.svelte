<!--
  Account › Users (agents.html §X) — WHOSE APP THIS IS.

  The admin's module, beside Agents: who may use this tracker, when they were
  added and when they last signed in; add an address (before that person has
  ever signed in) and take access away. The admin's own row is first, marked,
  and has no Remove — that address comes from configuration and cannot be
  taken away from inside the app.

  Nobody else sees this section (the menus hide it), and nobody else can call
  its commands — the server checks the address on every one of them.
-->
<script lang="ts">
  import { ShieldCheck, Trash2, UserPlus, Users } from 'lucide-svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { Button, Dialog, EmptyState, Input, Skeleton, toast } from '$lib/ui';
  import { dateOnly, relativeTime } from '../format';
  import SectionHeader from '../SectionHeader.svelte';
  import {
    ADMIN_EMAIL,
    allowUser,
    amIAdmin,
    disallowUser,
    fetchUsers,
    signInLabel,
    type AllowedUser,
  } from '../allow';

  const admin = $derived(amIAdmin(auth.user?.email));

  let users = $state<AllowedUser[]>([]);
  let adminAddress = $state('');
  let loading = $state(true);
  let loadError = $state(false);

  async function load() {
    loading = true;
    try {
      const r = await fetchUsers();
      users = r.users;
      adminAddress = r.admin;
      loadError = false;
    } catch {
      loadError = true; // toasted by command()
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (admin && loading && !loadError) void load();
  });

  // ── add ──
  let addOpen = $state(false);
  let email = $state('');
  let note = $state('');
  let emailError = $state<string | null>(null);
  let adding = $state(false);
  let addForm = $state<HTMLFormElement | null>(null);

  function openAdd() {
    email = '';
    note = '';
    emailError = null;
    addOpen = true;
  }

  async function add(e: SubmitEvent) {
    e.preventDefault();
    const addr = email.trim().toLowerCase();
    emailError = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(addr)
      ? null
      : 'That does not look like an email address.';
    if (emailError) return;
    adding = true;
    try {
      const r = await allowUser(addr, note.trim() || undefined);
      users = r.users;
      adminAddress = r.admin;
      addOpen = false;
      toast.success(`${addr} can use TaskManager`);
    } catch {
      /* toasted */
    } finally {
      adding = false;
    }
  }

  // ── remove ── (the same confirmation manners as Tokens and Agents)
  let target = $state<AllowedUser | null>(null);
  let removeOpen = $state(false);
  let removing = $state(false);

  function confirmRemove(u: AllowedUser) {
    target = u;
    removeOpen = true;
  }

  async function remove() {
    if (!target) return;
    removing = true;
    const u = target;
    try {
      const r = await disallowUser(u.email);
      users = r.users;
      removeOpen = false;
      toast.success(`${u.email} can no longer use TaskManager`);
    } catch {
      /* toasted */
    } finally {
      removing = false;
    }
  }
</script>

<SectionHeader
  title="Users"
  description="TaskManager is private: anyone can sign in, but only the accounts below can do anything. Everyone else lands on a screen asking you for access."
>
  {#snippet actions()}
    {#if admin}<Button variant="primary" icon={UserPlus} onclick={openAdd}>Add someone</Button>{/if}
  {/snippet}
</SectionHeader>

{#if !admin}
  <EmptyState
    icon={ShieldCheck}
    title="Only the admin manages access"
    description="Who may use this TaskManager is set by its owner, {ADMIN_EMAIL}. Ask them if you need to let someone in."
  />
{:else if loading}
  <div class="flex flex-col gap-2"><Skeleton height="3.5rem" /><Skeleton height="3.5rem" /></div>
{:else if loadError}
  <EmptyState
    icon={Users}
    title="Could not load the list"
    description="Something went wrong reading who may use this app."
  >
    {#snippet action()}<Button onclick={load}>Try again</Button>{/snippet}
  </EmptyState>
{:else}
  <ul class="flex flex-col gap-2" aria-label="People who may use this TaskManager">
    {#each users as u (u.email)}
      <li class="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4">
        <div class="min-w-0 flex-1">
          <p class="flex flex-wrap items-center gap-2 text-sm font-medium">
            <span class="truncate">{u.name ?? u.email}</span>
            {#if u.admin}
              <span
                class="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted"
              >
                <ShieldCheck size={12} aria-hidden="true" /> Admin
              </span>
            {/if}
            {#if !u.uid}
              <span class="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted"
                >Invited, not signed in</span
              >
            {/if}
          </p>
          <p class="truncate text-sm text-muted">{u.email}</p>
          <p class="mt-0.5 text-xs text-subtle">
            {#if u.admin}
              Allowed by configuration · {signInLabel(u, (ms) => relativeTime(ms))}
            {:else}
              Added {dateOnly(u.addedAt, auth.profile?.timezone)} · {signInLabel(u, (ms) =>
                relativeTime(ms),
              )}
            {/if}
            {#if u.note}
              · {u.note}{/if}
          </p>
        </div>
        {#if !u.admin}
          <Button variant="ghost" icon={Trash2} onclick={() => confirmRemove(u)}
            >Take access away</Button
          >
        {/if}
      </li>
    {/each}
  </ul>
  <p class="mt-4 text-xs text-subtle">
    {adminAddress || ADMIN_EMAIL} is the admin and is always allowed — that address is set in configuration,
    not here.
  </p>
{/if}

<Dialog bind:open={addOpen} title="Let someone in" size="sm">
  <form bind:this={addForm} class="flex flex-col gap-4" onsubmit={add} novalidate>
    <Input
      label="Email address"
      hint="The address they sign in with. They can be added before they have ever signed in."
      type="email"
      autocomplete="email"
      bind:value={email}
      error={emailError}
    />
    <Input
      label="Note (optional)"
      hint="A reminder of who this is."
      maxlength={200}
      bind:value={note}
    />
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (addOpen = false)}>Cancel</Button>
    <Button variant="primary" loading={adding} onclick={() => addForm?.requestSubmit()}
      >Allow</Button
    >
  {/snippet}
</Dialog>

<Dialog
  bind:open={removeOpen}
  title="Take access away from {target?.email ?? 'this person'}?"
  size="sm"
>
  <p class="text-sm">
    They can still sign in, but they will land on the "ask for access" screen and can reach nothing
    else. Anything they have running with a token stops on its next request. You can let them back
    in at any time.
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (removeOpen = false)}>Cancel</Button>
    <Button variant="danger" loading={removing} onclick={remove}>Take access away</Button>
  {/snippet}
</Dialog>

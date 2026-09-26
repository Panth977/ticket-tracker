<!--
  Create board (app.json › Create board). Template chips, a name, a key
  (suggested from the name, checked live against boardKeys/{key}), a colour,
  and people to invite inline. boardCreate makes you its admin; the invites
  go out right after (inviteCreate) — a failed invite never loses the board.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { onDestroy } from 'svelte';
  import { ArrowLeft, Check, CircleAlert, LoaderCircle, Plus, X } from 'lucide-svelte';
  import type { BoardRole, BoardTemplate } from '@tm/shared';
  import { command, isAppError } from '$lib/api';
  import {
    createKeyChecker,
    keyShapeError,
    normalizeKey,
    suggestKey,
    type KeyStatus,
  } from '$lib/account/boardKey';
  import { addInvites, ROLE_OPTIONS, type InviteDraft } from '$lib/account/inviteDraft';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { myBoards } from '$lib/stores';
  import { Button, ColorSwatch, Input, PALETTE, Select, toast } from '$lib/ui';

  type Chip = 'blank' | 'kanban' | 'bugs' | 'support' | 'sprint' | 'copy';
  const CHIPS: { id: Chip; label: string; hint: string }[] = [
    { id: 'blank', label: 'Blank', hint: 'To do · In progress · Done' },
    { id: 'kanban', label: 'Kanban', hint: 'Backlog → Review → Done' },
    { id: 'bugs', label: 'Bug tracker', hint: 'Triage, severity, versions' },
    { id: 'support', label: 'Support desk', hint: 'Requests, waiting on customer' },
    { id: 'sprint', label: 'Sprint', hint: 'Estimates, sprint field' },
    { id: 'copy', label: 'Copy a board', hint: 'Stages, fields and views — never people' },
  ];

  let chip = $state<Chip>('kanban');
  let copyFrom = $state<string | null>(null);
  let name = $state('');
  let key = $state('');
  /** Once the key is typed by hand, the name stops rewriting it. */
  let keyTouched = $state(false);
  let keyStatus = $state<KeyStatus>('idle');
  let color = $state<string | null>(PALETTE[6] ?? '#3b82f6');
  let nameError = $state<string | null>(null);

  let inviteText = $state('');
  let inviteRole = $state<BoardRole>('editor');
  let invites = $state<InviteDraft[]>([]);
  let inviteError = $state<string | null>(null);

  let creating = $state(false);

  const boardsQ = $derived(myBoards(auth.uid));
  const copyOptions = $derived(
    $boardsQ.data
      .map((b) => ({ value: b.id, label: `${b.key} · ${b.name}` }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );

  const checker = createKeyChecker((k, s) => {
    if (k === key) keyStatus = s;
  });
  onDestroy(() => checker.dispose());

  function onName(v: string) {
    name = v;
    nameError = null;
    if (!keyTouched) setKey(suggestKey(v));
  }
  function setKey(v: string) {
    key = normalizeKey(v);
    checker.check(key);
  }

  function addPeople() {
    const r = addInvites(invites, inviteText, inviteRole, auth.user?.email);
    invites = r.list;
    inviteError = r.rejected.length ? `Not an email address: ${r.rejected.join(', ')}` : null;
    if (!r.rejected.length) inviteText = '';
  }
  function inviteKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (inviteText.trim()) addPeople();
    }
  }

  const keyMessage = $derived(
    keyStatus === 'invalid'
      ? keyShapeError(key)
      : keyStatus === 'taken'
        ? `${key} is taken — try another.`
        : null,
  );
  const canCreate = $derived(
    !!name.trim() &&
      !keyShapeError(key) &&
      keyStatus !== 'taken' &&
      keyStatus !== 'checking' &&
      (chip !== 'copy' || !!copyFrom),
  );

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim()) nameError = 'Give the board a name.';
    if (inviteText.trim()) addPeople();
    if (!canCreate || inviteError) return;
    creating = true;
    const template: BoardTemplate = chip === 'copy' ? { fromBoardId: copyFrom! } : chip;
    try {
      const { boardId } = await command(
        'boardCreate',
        { name: name.trim(), key, template, ...(color ? { color } : {}) },
        { toast: false },
      );
      if (invites.length) {
        try {
          const r = await command(
            'inviteCreate',
            { boardId, invites },
            { toast: 'Board created, but the invites failed' },
          );
          if (r.invited.length) toast.success(`Board created — invited ${r.invited.length}`);
        } catch {
          /* toasted; the board exists — invite from People */
        }
      } else toast.success('Board created');
      await goto(routes.board(key), { replaceState: true });
    } catch (err) {
      if (isAppError(err) && err.code === 'conflict') {
        keyStatus = 'taken';
      } else if (isAppError(err) && err.code === 'rate_limited') {
        toast.error('You’ve created a lot of boards today — try again tomorrow.');
      } else if (isAppError(err)) {
        toast.error('Could not create the board', err.message);
      } else throw err;
    } finally {
      creating = false;
    }
  }
</script>

<svelte:head><title>New board · TaskManager</title></svelte:head>

<main class="min-h-dvh bg-bg px-4 py-8 sm:py-12">
  <div class="mx-auto flex w-full max-w-2xl flex-col gap-6">
    <div>
      <Button variant="ghost" size="sm" icon={ArrowLeft} href={routes.home()}>Boards</Button>
    </div>
    <h1 class="text-2xl font-semibold">Create a board</h1>

    <form class="flex flex-col gap-6" onsubmit={create} novalidate>
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-2 text-sm font-medium">Start from</legend>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Template">
          {#each CHIPS as c (c.id)}
            <button
              type="button"
              role="radio"
              aria-checked={chip === c.id}
              class="flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors {chip ===
              c.id
                ? 'border-accent bg-accent-soft'
                : 'border-line bg-surface hover:bg-surface-2'}"
              onclick={() => (chip = c.id)}
            >
              <span class="text-sm font-medium">{c.label}</span>
              <span class="text-xs text-muted">{c.hint}</span>
            </button>
          {/each}
        </div>
        {#if chip === 'copy'}
          <Select
            label="Board to copy"
            placeholder={copyOptions.length ? 'Pick a board' : 'You are not on any boards yet'}
            options={copyOptions}
            bind:value={copyFrom}
          />
        {/if}
      </fieldset>

      <div class="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
        <Input
          label="Name"
          placeholder="Engineering"
          maxlength={80}
          value={name}
          oninput={(e) => onName((e.currentTarget as HTMLInputElement).value)}
          error={nameError}
        />
        <div class="flex flex-col gap-1">
          <div class="flex items-end gap-3">
            <Input
              class="w-40"
              inputClass="font-mono uppercase"
              label="Key"
              placeholder="ENG"
              maxlength={6}
              autocapitalize="characters"
              spellcheck="false"
              value={key}
              oninput={(e) => {
                keyTouched = true;
                setKey((e.currentTarget as HTMLInputElement).value);
              }}
              aria-describedby="key-status"
            />
            <p id="key-status" class="flex h-8 items-center gap-1.5 text-sm" aria-live="polite">
              {#if keyStatus === 'checking'}
                <LoaderCircle size={14} class="animate-spin text-muted" aria-hidden="true" /><span
                  class="text-muted">Checking…</span
                >
              {:else if keyStatus === 'free'}
                <Check size={14} class="text-success" aria-hidden="true" /><span
                  class="text-success">{key} is available</span
                >
              {:else if keyMessage}
                <CircleAlert size={14} class="text-danger" aria-hidden="true" /><span
                  class="text-danger">{keyMessage}</span
                >
              {:else if keyStatus === 'unknown'}
                <span class="text-muted">Couldn’t check — we’ll know when you create it.</span>
              {/if}
            </p>
          </div>
          <p class="text-xs text-muted">
            Tickets are numbered with it: <span class="font-mono">{key || 'ENG'}-42</span>. It’s
            unique across TaskManager and can’t be changed later.
          </p>
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="text-sm font-medium">Colour</span>
          <ColorSwatch options={PALETTE} bind:value={color} label="Board colour" size={20} />
        </div>
      </div>

      <div class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5">
        <div>
          <h2 class="text-sm font-medium">
            Invite people <span class="font-normal text-muted">(optional)</span>
          </h2>
          <p class="text-xs text-muted">
            They get an email and join when they accept. Paste several at once.
          </p>
        </div>
        <div class="flex flex-wrap items-end gap-2">
          <Input
            class="min-w-48 flex-1"
            label="Email"
            type="email"
            placeholder="asha@company.com"
            bind:value={inviteText}
            onkeydown={inviteKey}
            error={inviteError}
          />
          <Select class="w-36" label="Role" options={ROLE_OPTIONS} bind:value={inviteRole} />
          <Button icon={Plus} onclick={addPeople} disabled={!inviteText.trim()}>Add</Button>
        </div>
        {#if invites.length}
          <ul class="flex flex-col divide-y divide-line rounded-lg border border-line">
            {#each invites as inv, i (inv.email)}
              <li class="flex items-center gap-2 px-3 py-1.5">
                <span class="flex-1 truncate text-sm">{inv.email}</span>
                <select
                  class="h-7 rounded-md border border-line bg-surface px-1.5 text-xs"
                  aria-label="Role for {inv.email}"
                  bind:value={invites[i]!.role}
                >
                  {#each ROLE_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option
                    >{/each}
                </select>
                <button
                  type="button"
                  class="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
                  aria-label="Remove {inv.email}"
                  onclick={() => (invites = invites.filter((x) => x.email !== inv.email))}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" href={routes.home()}>Cancel</Button>
        <Button type="submit" variant="primary" size="lg" loading={creating} disabled={!canCreate}
          >Create board</Button
        >
      </div>
    </form>
  </div>
</main>

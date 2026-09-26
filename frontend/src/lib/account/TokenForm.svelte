<!--
  New token (agents.html §E, §R1):
    Name · What it reaches: Me on one board | An agent on one board |
    ACCOUNT TOKEN (me, on every board I'm on) · Permissions (checkboxes +
    presets) · Expires.
  What a token may do is its permissions ∩ what its principal's board role
  allows, so a commenter agent can never move outside its stage grant, and an
  account token is an admin only where you already are one.
  Admin permissions are offered only to a board token acting as you, on a
  board where you are admin; the ACCOUNT permissions only to an account token.
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- agentRoutes; the SPA has no base path */
  import {
    ADMIN_SCOPES,
    SCOPE_LABELS,
    SCOPE_PRESETS,
    isAccountScope,
    presetOf,
    type Board,
    type Scope,
    type ScopePreset,
  } from '@tm/shared';
  import { Globe, TriangleAlert } from 'lucide-svelte';
  import { myAgents, sortAgents } from '$lib/agents/agents';
  import { agentRoutes } from '$lib/agents/routes';
  import { auth } from '$lib/firebase/auth.svelte';
  import { PrincipalAvatar } from '$lib/people';
  import type { WithId } from '$lib/stores';
  import { Checkbox, Input, Select } from '$lib/ui';
  import {
    ACCOUNT_SCOPE_SECTION,
    ACCOUNT_TOKEN_NEVER,
    choiceOf,
    EXPIRY_OPTIONS,
    expiryIsRisky,
    presetsFor,
    SCOPE_SECTIONS,
    toggleScope,
    tokenDraftErrors,
    withChoice,
    type TokenChoice,
    type TokenDraft,
  } from './tokens';

  interface Props {
    draft: TokenDraft;
    boards: WithId<Board>[];
    /** Show errors (after the first submit). */
    touched: boolean;
    onsubmit: (e: SubmitEvent) => void;
  }
  let { draft = $bindable(), boards, touched, onsubmit }: Props = $props();

  const me = $derived(auth.uid ?? '');
  const account = $derived(draft.kind === 'account');
  const choice = $derived(choiceOf(draft));
  const presets = $derived(presetsFor(draft.kind));
  const board = $derived(boards.find((b) => b.id === draft.boardId) ?? null);
  const agentsQ = $derived(myAgents(me));
  /** My agents on the chosen board (the board's access map holds agents too). */
  const agentsHere = $derived(
    board
      ? sortAgents($agentsQ.data).filter((a) => a.archivedAt == null && board.access[a.id] != null)
      : [],
  );
  const adminHere = $derived(!!board && board.access[me] === 'admin');
  const offerAdmin = $derived(!account && draft.actsAs === 'me' && adminHere);
  const errors = $derived(tokenDraftErrors(draft));
  /* Which preset button looks pressed: compare the WHOLE list for an account
     token (its 'Full account' preset includes the account scopes), and only
     the board checkboxes for a board token (admin scopes are separate). */
  const preset = $derived(
    account
      ? presetOf(draft.scopes)
      : presetOf(draft.scopes.filter((s) => !(ADMIN_SCOPES as readonly string[]).includes(s))),
  );
  const boardsIAmOn = $derived(boards.length);

  // Keep the draft consistent as the board / principal change.
  $effect(() => {
    if (account) return;
    if (
      draft.actsAs === 'agent' &&
      draft.agentId &&
      !agentsHere.some((a) => a.id === draft.agentId) &&
      !$agentsQ.loading
    )
      draft.agentId = agentsHere[0]?.id ?? null;
    if (draft.actsAs === 'agent' && !draft.agentId && agentsHere[0])
      draft.agentId = agentsHere[0].id;
  });
  $effect(() => {
    if (!offerAdmin && draft.scopes.some((s) => (ADMIN_SCOPES as readonly string[]).includes(s)))
      draft.scopes = draft.scopes.filter((s) => !(ADMIN_SCOPES as readonly string[]).includes(s));
  });
  // A board token may never carry account permissions (the command refuses them).
  $effect(() => {
    if (!account && draft.scopes.some(isAccountScope))
      draft.scopes = draft.scopes.filter((s) => !isAccountScope(s));
  });

  function usePreset(p: ScopePreset) {
    const admin = account
      ? []
      : draft.scopes.filter((s) => (ADMIN_SCOPES as readonly string[]).includes(s));
    draft.scopes = [...SCOPE_PRESETS[p], ...admin] as Scope[];
  }

  /** The three choices of §R1, as one control. */
  function pick(c: TokenChoice) {
    draft = withChoice(draft, c);
  }
  const boardOptions = $derived(
    boards.map((b) => ({ value: b.id, label: `${b.key} · ${b.name}` })),
  );
  const agentOptions = $derived(agentsHere.map((a) => ({ value: a.id, label: a.name })));
</script>

<form id="token-form" class="flex flex-col gap-5" {onsubmit} novalidate data-token-form>
  <Input
    label="Name"
    placeholder="orch-eng-builder"
    maxlength={80}
    bind:value={draft.name}
    error={touched ? errors.name : null}
  />

  <fieldset class="flex flex-col gap-2">
    <legend class="mb-1 text-sm font-medium">What it reaches</legend>
    <div class="flex flex-wrap gap-2" role="radiogroup" data-token-kind>
      <label
        class="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm {choice ===
        'me'
          ? 'border-accent bg-accent-soft'
          : 'border-line'}"
      >
        <input
          type="radio"
          name="tokenChoice"
          value="me"
          checked={choice === 'me'}
          onchange={() => pick('me')}
          class="accent-[var(--tm-accent)]"
        />
        <PrincipalAvatar id={me} size={20} /> Me, on one board
      </label>
      <label
        class="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm {choice ===
        'agent'
          ? 'border-accent bg-accent-soft'
          : 'border-line'}"
      >
        <input
          type="radio"
          name="tokenChoice"
          value="agent"
          checked={choice === 'agent'}
          onchange={() => pick('agent')}
          class="accent-[var(--tm-accent)]"
        />
        An agent, on one board
      </label>
      <!-- §R1 — the third choice: "virtual me". -->
      <label
        class="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm {choice ===
        'account'
          ? 'border-accent bg-accent-soft'
          : 'border-line'}"
      >
        <input
          type="radio"
          name="tokenChoice"
          value="account"
          checked={choice === 'account'}
          onchange={() => pick('account')}
          class="accent-[var(--tm-accent)]"
        />
        <Globe size={18} aria-hidden="true" /> Account token
      </label>
    </div>

    {#if account}
      <!--
        §R1: "a plain warning of what it can reach". Said in full, before the
        token exists — not in a tooltip after the fact.
      -->
      <div
        class="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning"
        data-account-warning
      >
        <TriangleAlert size={16} class="mt-0.5 shrink-0" aria-hidden="true" />
        <div class="flex flex-col gap-1">
          <p>
            This token acts as <strong>you</strong> on
            <strong>every board you are on</strong>{boardsIAmOn ? ` (${boardsIAmOn} today)` : ''} — including
            boards you join later, and losing a board takes it away again. Everything it does is recorded
            as yours, “via token {draft.name.trim() || '…'}”.
          </p>
          <p>
            Whatever you tick below, it can never {ACCOUNT_TOKEN_NEVER.join(', ')}. A token can
            never mint another token, so a leak cannot become permanent.
          </p>
        </div>
      </div>
    {:else}
      <Select
        label="Board"
        hint="Each board token works on exactly one board."
        placeholder="Pick a board"
        options={boardOptions}
        bind:value={draft.boardId}
        error={touched ? errors.boardId : null}
      />
    {/if}

    {#if !account && draft.actsAs === 'agent'}
      {#if !board}
        <p class="text-xs text-muted">Pick a board first.</p>
      {:else if $agentsQ.loading}
        <p class="text-xs text-muted">Loading your agents…</p>
      {:else if !agentsHere.length}
        <p class="text-xs text-danger">
          None of your agents is on {board.name}.
          <a class="text-accent hover:underline" href={agentRoutes.list()}>Add one to the board</a> first.
        </p>
      {:else}
        <div class="flex items-end gap-2">
          {#if draft.agentId}<PrincipalAvatar id={draft.agentId} size={32} />{/if}
          <Select
            class="flex-1"
            label="Agent"
            options={agentOptions}
            bind:value={draft.agentId}
            error={touched ? errors.agentId : null}
          />
        </div>
        <p class="text-xs text-muted">
          The token carries this agent’s identity: its changes are authored by the agent, and it
          reads the agent’s inbox and system prompt.
        </p>
      {/if}
    {/if}
  </fieldset>

  <fieldset class="flex flex-col gap-3">
    <legend class="mb-1 text-sm font-medium">Permissions</legend>
    <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Presets">
      <span class="text-xs text-muted">Presets:</span>
      {#each presets as p (p.id)}
        <button
          type="button"
          class="rounded-full border px-2.5 py-0.5 text-xs {preset === p.id
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-line text-muted hover:text-text'}"
          aria-pressed={preset === p.id}
          onclick={() => usePreset(p.id)}>{p.label}</button
        >
      {/each}
      {#if !preset && draft.scopes.length}<span class="text-xs text-subtle">Custom</span>{/if}
    </div>
    <div class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {#each SCOPE_SECTIONS as sec (sec.title)}
        <div class="flex flex-col gap-1.5">
          <p class="text-xs font-semibold tracking-wide text-subtle uppercase">{sec.title}</p>
          {#each sec.scopes as s (s)}
            <Checkbox
              checked={draft.scopes.includes(s)}
              label={s}
              description={SCOPE_LABELS[s]}
              onchange={(e) =>
                (draft.scopes = toggleScope(
                  draft.scopes,
                  s,
                  (e.currentTarget as HTMLInputElement).checked,
                ))}
            />
          {/each}
        </div>
      {/each}
      {#if offerAdmin}
        <div class="flex flex-col gap-1.5">
          <p class="text-xs font-semibold tracking-wide text-subtle uppercase">
            Admin (you are admin here)
          </p>
          {#each ADMIN_SCOPES as s (s)}
            <Checkbox
              checked={draft.scopes.includes(s)}
              label={s}
              description={SCOPE_LABELS[s]}
              onchange={(e) =>
                (draft.scopes = toggleScope(
                  draft.scopes,
                  s,
                  (e.currentTarget as HTMLInputElement).checked,
                ))}
            />
          {/each}
        </div>
      {/if}
      {#if account}
        <!-- §R1 — the account-level permissions, only on an account token. -->
        <div class="flex flex-col gap-1.5" data-account-scopes>
          <p class="text-xs font-semibold tracking-wide text-subtle uppercase">
            {ACCOUNT_SCOPE_SECTION.title}
          </p>
          {#each ACCOUNT_SCOPE_SECTION.scopes as s (s)}
            <Checkbox
              checked={draft.scopes.includes(s)}
              label={s}
              description={SCOPE_LABELS[s]}
              onchange={(e) =>
                (draft.scopes = toggleScope(
                  draft.scopes,
                  s,
                  (e.currentTarget as HTMLInputElement).checked,
                ))}
            />
          {/each}
        </div>
      {/if}
    </div>
    {#if touched && errors.scopes}<p class="text-xs text-danger">{errors.scopes}</p>{/if}
    <p class="text-xs text-muted">
      {#if account}
        A permission only narrows what your role on each board already allows — never widens it.
        Ticking <code>boards:admin</code>
        changes nothing on boards where you are not an admin.
      {:else}
        A token can only narrow what {draft.actsAs === 'agent' ? 'the agent’s' : 'your'} role on the board
        allows — never widen it.
      {/if}
    </p>
  </fieldset>

  <div class="flex flex-col gap-1">
    <Select class="w-40" label="Expires" options={EXPIRY_OPTIONS} bind:value={draft.expiry} />
    {#if expiryIsRisky(draft.kind, draft.expiry)}
      <!-- §R1: never is possible, and says so in red. -->
      <p class="flex items-center gap-1.5 text-xs text-danger" data-never-warning>
        <TriangleAlert size={14} aria-hidden="true" />
        A token that never expires, for your whole account. Give it an expiry unless you really need this.
      </p>
    {/if}
  </div>
</form>

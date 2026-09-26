<!--
  Authorize an app (app.json › Authorize an app) — where GET /oauth/authorize
  lands. Shows who is asking (the registered client's name) and what for, in
  plain words; you can narrow it (fewer permissions, only some boards) but
  never widen it. Allow → the server issues a code and says where to send
  the browser; the grant then appears in Account › Connected apps, revocable.
  Firebase Auth is the IDENTITY; this is only the DELEGATION.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { CircleAlert, ShieldCheck } from 'lucide-svelte';
  import type { Scope } from '@tm/shared';
  import { isAppError } from '$lib/api';
  import BoardPicker from '$lib/account/BoardPicker.svelte';
  import { decide, fetchClientInfo, parseAuthorize, type ClientInfo } from '$lib/account/oauth';
  import { groupsFor, scopesFromGroups } from '$lib/account/scopes';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { person } from '$lib/people/person';
  import { Avatar, Button, Checkbox } from '$lib/ui';

  const parsed = $derived(parseAuthorize(page.url.searchParams));
  const req = $derived(parsed.ok ? parsed.req : null);
  const groups = $derived(req ? groupsFor(req.scopes) : []);

  let client = $state<ClientInfo | null>(null);
  let loadError = $state<string | null>(null);
  let picked = $state<string[]>([]);
  let boardIds = $state<string[] | null>(null);
  let busy = $state<'allow' | 'cancel' | null>(null);
  let error = $state<string | null>(null);

  const me = $derived(person(auth.uid));
  const scopes: Scope[] = $derived(req ? scopesFromGroups(picked, req.scopes) : []);
  const canAllow = $derived(
    !!client && scopes.length > 0 && (boardIds === null || boardIds.length > 0),
  );

  onMount(async () => {
    if (!parsed.ok || !req) return;
    picked = groupsFor(req.scopes).map((g) => g.id);
    try {
      client = await fetchClientInfo(req);
    } catch (e) {
      loadError =
        isAppError(e) && (e.code === 'not_found' || e.code === 'invalid')
          ? 'This app isn’t registered, or its return address doesn’t match. Go back to the app and try again.'
          : 'Couldn’t reach TaskManager to check this app — try again.';
    }
  });

  async function answer(approve: boolean) {
    if (!req) return;
    busy = approve ? 'allow' : 'cancel';
    error = null;
    try {
      const { redirect } = await decide(req, {
        approve,
        scopes: approve ? scopes : [],
        boardIds: approve ? boardIds : null,
      });
      // Leave the SPA for the app's redirect_uri (validated by the server).
      window.location.assign(redirect);
    } catch (e) {
      busy = null;
      error = isAppError(e) && e.message ? e.message : 'Something went wrong — try again.';
    }
  }

  function toggle(id: string, on: boolean) {
    picked = on ? [...new Set([...picked, id])] : picked.filter((p) => p !== id);
  }
  const host = $derived.by(() => {
    try {
      return req ? new URL(req.redirectUri).host : '';
    } catch {
      return '';
    }
  });
</script>

<svelte:head><title>Authorize {client?.clientName ?? 'an app'} · TaskManager</title></svelte:head>

<main class="grid min-h-dvh place-items-center bg-bg px-4 py-10">
  <div class="w-full max-w-md rounded-xl border border-line bg-surface shadow-pop">
    {#if !parsed.ok}
      <div class="flex flex-col gap-3 p-6">
        <span class="text-danger"><CircleAlert size={22} aria-hidden="true" /></span>
        <h1 class="text-lg font-semibold">This authorization link is broken</h1>
        <p class="text-sm text-muted">{parsed.error}</p>
        <Button href={routes.home()}>Go to TaskManager</Button>
      </div>
    {:else if loadError}
      <div class="flex flex-col gap-3 p-6">
        <span class="text-danger"><CircleAlert size={22} aria-hidden="true" /></span>
        <h1 class="text-lg font-semibold">Can’t authorize this app</h1>
        <p class="text-sm text-muted">{loadError}</p>
      </div>
    {:else if !client}
      <div class="flex items-center gap-3 p-6 text-sm text-muted" aria-busy="true">
        <span class="size-5 animate-spin rounded-full border-2 border-line-strong border-t-accent"
        ></span>
        Checking the app…
      </div>
    {:else}
      <div class="flex flex-col gap-5 p-6">
        <div class="flex items-center gap-3">
          {#if client.logoUrl}
            <img
              src={client.logoUrl}
              alt=""
              class="size-10 rounded-lg border border-line object-cover"
            />
          {:else}
            <span
              class="grid size-10 place-items-center rounded-lg bg-surface-2 text-lg font-semibold text-muted"
              aria-hidden="true"
            >
              {client.clientName.slice(0, 1).toUpperCase()}
            </span>
          {/if}
          <div class="min-w-0">
            <h1 class="text-lg leading-tight font-semibold">
              {client.clientName} wants to use your TaskManager account
            </h1>
            {#if host}<p class="text-xs text-muted">It will return you to {host}</p>{/if}
          </div>
        </div>

        <div class="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
          <Avatar
            src={$me.person?.avatarUrl}
            name={$me.person?.name ?? auth.user?.email ?? ''}
            seed={auth.uid ?? ''}
            size={22}
            decorative
          />
          <span class="min-w-0 flex-1 truncate"
            >{$me.person?.name ?? ''} <span class="text-muted">{auth.user?.email}</span></span
          >
        </div>

        <fieldset class="flex flex-col gap-2">
          <legend class="mb-1 text-sm font-medium">It will be able to</legend>
          {#each groups as g (g.id)}
            <Checkbox
              checked={picked.includes(g.id)}
              label={g.label}
              description={g.hint}
              onchange={(e) => toggle(g.id, (e.currentTarget as HTMLInputElement).checked)}
            />
          {/each}
          {#if !scopes.length}<p class="text-xs text-danger">
              Leave at least one ticked, or cancel.
            </p>{/if}
          <p class="text-xs text-muted">
            Only ever what you can already do on each board — acting as you, labelled “via {client.clientName}”.
          </p>
        </fieldset>

        <BoardPicker bind:value={boardIds} label="On these boards" />

        {#if error}<p class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
            {error}
          </p>{/if}
      </div>
      <footer class="flex items-center gap-2 border-t border-line px-6 py-4">
        <span class="flex flex-1 items-center gap-1.5 text-xs text-muted">
          <ShieldCheck size={14} aria-hidden="true" /> Revoke any time in Account › Connected apps
        </span>
        <Button
          variant="ghost"
          loading={busy === 'cancel'}
          disabled={busy !== null}
          onclick={() => answer(false)}>Cancel</Button
        >
        <Button
          variant="primary"
          loading={busy === 'allow'}
          disabled={!canAllow || busy !== null}
          onclick={() => answer(true)}
        >
          Allow
        </Button>
      </footer>
    {/if}
  </div>
</main>

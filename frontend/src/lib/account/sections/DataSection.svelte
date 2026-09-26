<!--
  Account › Data & deletion.
    Export: queued (accountExport); a download link (valid 7 days) is emailed.
    Delete: type DELETE, prove it's you (a recent sign-in), then accountDelete.
      Your messages STAY, shown as 'Deleted user' — deleting them would
      rewrite other people's conversations. The only admin of a board with
      other people gets a 409 naming those boards.
-->
<script lang="ts">
  // goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { Download, Trash2 } from 'lucide-svelte';
  import { command, isAppError } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { Button, Dialog, Input, toast } from '$lib/ui';
  import { authErrorMessage } from '../authErrors';
  import Panel from '../Panel.svelte';
  import { providerIds, reauthenticate, reauthMethod } from '../reauth';
  import SectionHeader from '../SectionHeader.svelte';

  let exporting = $state(false);
  let exported = $state(false);
  async function exportData() {
    exporting = true;
    try {
      await command('accountExport', {}, { toast: 'Could not start the export' });
      exported = true;
    } catch {
      /* toasted */
    } finally {
      exporting = false;
    }
  }

  let open = $state(false);
  let confirm = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  /** Boards that block deletion (409). */
  let blocking = $state<string[]>([]);
  const method = $derived(reauthMethod(providerIds()));

  function openDelete() {
    confirm = '';
    password = '';
    error = null;
    blocking = [];
    open = true;
  }

  /** '409 details' may name boards as strings or { key, name } objects. */
  function boardNames(details: Record<string, unknown> | undefined): string[] {
    const list = (details?.boards ?? details?.boardKeys ?? []) as unknown[];
    return Array.isArray(list)
      ? list.map((b) =>
          typeof b === 'string'
            ? b
            : [(b as { key?: string }).key, (b as { name?: string }).name]
                .filter(Boolean)
                .join(' · '),
        )
      : [];
  }

  async function del(e: SubmitEvent) {
    e.preventDefault();
    if (confirm !== 'DELETE') return;
    busy = true;
    error = null;
    blocking = [];
    try {
      let ok: boolean;
      try {
        ok = await reauthenticate(password || undefined);
      } catch (err) {
        error = authErrorMessage(err);
        return;
      }
      if (!ok) {
        error =
          method === 'password'
            ? 'Enter your password to confirm it’s you.'
            : 'For your security, sign in again with a fresh email link, then come back here.';
        return;
      }
      await command('accountDelete', { confirm: 'DELETE', recentLogin: true }, { toast: false });
      open = false;
      await auth.signOut().catch(() => {});
      toast.info('Your account was deleted.');
      await goto(routes.login(), { replaceState: true });
    } catch (err) {
      if (!isAppError(err)) throw err;
      if (err.code === 'conflict') {
        blocking = boardNames(err.details);
        error = err.message || 'You’re the only admin of boards that have other people on them.';
      } else if (err.code === 'forbidden') {
        error = 'For your security, sign in again, then retry.';
      } else error = err.message || 'Could not delete your account.';
    } finally {
      busy = false;
    }
  }

  async function signInAgain() {
    await auth.signOut();
    await goto(routes.login(routes.account('data')), { replaceState: true });
  }
</script>

<SectionHeader
  title="Data & deletion"
  description="Take your data with you, or close your account."
/>

<div class="flex flex-col gap-6">
  <Panel
    title="Export your data"
    description="Your profile, the messages you wrote and the tickets you created or were assigned, as JSON plus files, in one zip."
  >
    {#if exported}
      <p class="text-sm text-success" role="status">
        Export started. We’ll email a download link to {auth.user?.email} when it’s ready — it works for
        7 days.
      </p>
    {:else}
      <div>
        <Button icon={Download} loading={exporting} onclick={exportData}>Export my data</Button>
      </div>
    {/if}
  </Panel>

  <Panel
    tone="danger"
    title="Delete your account"
    description="You leave every board; boards where you’re the only person are deleted. Your comments stay, shown as “Deleted user”."
  >
    <div>
      <Button variant="danger" icon={Trash2} onclick={openDelete}>Delete my account…</Button>
    </div>
  </Panel>
</div>

<Dialog bind:open title="Delete your account?" size="sm">
  <form id="del-form" class="flex flex-col gap-3" onsubmit={del} novalidate>
    <p class="text-sm">
      This can’t be undone. If you’re the only admin of a board with other people on it, make
      someone else admin (or delete the board) first.
    </p>
    <Input
      label="Type DELETE to confirm"
      autocomplete="off"
      spellcheck="false"
      bind:value={confirm}
    />
    {#if method === 'password'}
      <Input
        label="Your password"
        type="password"
        autocomplete="current-password"
        bind:value={password}
      />
    {:else if method === 'emailLink'}
      <p class="text-xs text-muted">
        You signed in with an email link — it must be a recent sign-in (5 minutes).
      </p>
    {:else}
      <p class="text-xs text-muted">
        You’ll confirm with {method === 'google' ? 'Google' : 'Microsoft'} in a pop-up.
      </p>
    {/if}
    {#if error}
      <div class="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
        <p>{error}</p>
        {#if blocking.length}
          <ul class="mt-1 list-disc pl-5">
            {#each blocking as b (b)}<li>{b}</li>{/each}
          </ul>
        {/if}
        {#if method === 'emailLink' && !blocking.length}
          <Button variant="link" size="sm" onclick={signInAgain}>Sign in again</Button>
        {/if}
      </div>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button
      type="submit"
      form="del-form"
      variant="danger"
      loading={busy}
      disabled={confirm !== 'DELETE'}
    >
      Delete forever
    </Button>
  {/snippet}
</Dialog>
